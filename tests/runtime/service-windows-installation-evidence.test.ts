import { describe, expect, it } from "bun:test";

import { generateWindowsTaskXml } from "@selftune/local/service/windows/installation/definition";
import {
  inspectWindowsServiceTaskPrincipalScope,
  matchWindowsServiceTaskDefinition,
  type WindowsServiceTaskDefinitionExpectation,
  type WindowsServiceTaskDefinitionMismatch,
} from "@selftune/local/service/windows/installation/evidence";

const expectation: WindowsServiceTaskDefinitionExpectation = {
  boot: false,
  launcherPath: "C:\\Users\\Test\\.selftune\\server-control\\run-daemon.vbs",
  userSid: "S-1-5-21-1000-2000-3000-4000",
  wscriptPath: "C:\\Windows\\System32\\wscript.exe",
};

function taskXml(expected: WindowsServiceTaskDefinitionExpectation = expectation): string {
  return generateWindowsTaskXml({
    boot: expected.boot,
    commandPath: expected.wscriptPath,
    launcherPath: expected.launcherPath,
    userId: expected.userSid,
  });
}

function replaceOnce(xml: string, from: string, to: string): string {
  expect(xml.includes(from)).toBe(true);
  return xml.replace(from, to);
}

function expectMismatch(
  xml: string,
  reason: WindowsServiceTaskDefinitionMismatch,
  expected: WindowsServiceTaskDefinitionExpectation = expectation,
): void {
  expect(matchWindowsServiceTaskDefinition(xml, expected)).toEqual({ matches: false, reason });
}

describe("Windows service task definition evidence", () => {
  it("scopes install candidates by principal independently of mutable task behavior", () => {
    const canonical = taskXml();
    const tampered = canonical
      .replace("wscript.exe", "cscript.exe")
      .replace("IgnoreNew", "Parallel");
    expect(inspectWindowsServiceTaskPrincipalScope(tampered, expectation.userSid)).toEqual({
      _tag: "CurrentUser",
    });
    expect(inspectWindowsServiceTaskPrincipalScope(canonical, "S-1-5-21-9999")).toEqual({
      _tag: "DifferentUser",
    });
    expect(
      inspectWindowsServiceTaskPrincipalScope("<Task><Principals></Task>", expectation.userSid),
    ).toEqual({ _tag: "Invalid" });
    expect(
      inspectWindowsServiceTaskPrincipalScope(
        canonical.replace("</Principals>", '<Principal id="Other" /></Principals>'),
        expectation.userSid,
      ),
    ).toEqual({ _tag: "Invalid" });
  });

  it("matches generated logon and boot task definitions", () => {
    expect(matchWindowsServiceTaskDefinition(taskXml(), expectation)).toEqual({ matches: true });
    const bootExpectation = { ...expectation, boot: true };
    expect(matchWindowsServiceTaskDefinition(taskXml(bootExpectation), bootExpectation)).toEqual({
      matches: true,
    });
  });

  it("matches normalized exports regardless of xs:all child order", () => {
    let normalized = taskXml();
    normalized = replaceOnce(
      normalized,
      `<UserId>${expectation.userSid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>`,
      `<RunLevel>LeastPrivilege</RunLevel><DisplayName>SelfTune</DisplayName><LogonType>InteractiveToken</LogonType><UserId>${expectation.userSid.toLowerCase()}</UserId>`,
    );
    normalized = replaceOnce(
      normalized,
      `<Enabled>true</Enabled><UserId>${expectation.userSid}</UserId>`,
      `<UserId>${expectation.userSid.toLowerCase()}</UserId><Enabled>true</Enabled>`,
    );
    normalized = replaceOnce(
      normalized,
      "<Interval>PT1M</Interval><Count>3</Count>",
      "<Count>3</Count><Interval>PT1M</Interval>",
    );
    const settings = normalized.match(/<Settings>(.*)<\/Settings>/)?.[1];
    expect(settings).toBeDefined();
    normalized = replaceOnce(
      normalized,
      `<Settings>${settings}</Settings>`,
      `<Settings><Priority>7</Priority><UseUnifiedSchedulingEngine>false</UseUnifiedSchedulingEngine><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Count>3</Count><Interval>PT1M</Interval></RestartOnFailure><RunOnlyIfIdle>false</RunOnlyIfIdle><Hidden>false</Hidden><Enabled>true</Enabled><DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession><AllowStartOnDemand>true</AllowStartOnDemand><IdleSettings><RestartOnIdle>false</RestartOnIdle><StopOnIdleEnd>false</StopOnIdleEnd></IdleSettings><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><StartWhenAvailable>true</StartWhenAvailable><DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter><AllowHardTerminate>true</AllowHardTerminate><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>`,
    );
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
  });

  it("matches case-insensitive canonical Windows path and SID identities", () => {
    let normalized = taskXml();
    normalized = replaceOnce(
      normalized,
      expectation.wscriptPath,
      "c:/WINDOWS/system32/WSCRIPT.exe",
    );
    normalized = replaceOnce(
      normalized,
      expectation.launcherPath,
      "c:/users/test/.SELFTUNE/server-control/run-daemon.vbs",
    );
    normalized = normalized.replaceAll(expectation.userSid, expectation.userSid.toLowerCase());
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
  });

  it("accepts the scheduler-normalized default principal token SID type", () => {
    const normalized = replaceOnce(
      taskXml(),
      "</Principal>",
      "<ProcessTokenSidType>Default</ProcessTokenSidType></Principal>",
    );
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
  });

  it("accepts an omitted default run level only for a non-boot user task", () => {
    const bootExpectation = { ...expectation, boot: true };
    const normalized = replaceOnce(taskXml(), "<RunLevel>LeastPrivilege</RunLevel>", "");
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });

    const bootWithoutRunLevel = replaceOnce(
      taskXml(bootExpectation),
      "<RunLevel>HighestAvailable</RunLevel>",
      "",
    );
    expect(matchWindowsServiceTaskDefinition(bootWithoutRunLevel, bootExpectation)).toEqual({
      matches: false,
      reason: "principal-shape-mismatch",
    });
  });

  it("accepts an omitted default enabled flag on the trigger", () => {
    const normalized = replaceOnce(taskXml(), "<Enabled>true</Enabled>", "");
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
  });

  it("accepts an omitted default enabled flag on task settings", () => {
    const normalized = taskXml().replaceAll("<Enabled>true</Enabled>", "");
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
  });

  it("accepts the scheduler-elided default hard-termination flag", () => {
    const normalized = taskXml().replace("<AllowHardTerminate>true</AllowHardTerminate>", "");
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
  });

  it("accepts the scheduler-elided default network requirement", () => {
    const normalized = taskXml().replace(
      "<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
      "",
    );
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
  });

  it("accepts the scheduler-elided on-demand start default", () => {
    const normalized = taskXml().replace("<AllowStartOnDemand>true</AllowStartOnDemand>", "");
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
  });

  it("accepts the scheduler-elided hidden presentation default", () => {
    const normalized = taskXml().replace("<Hidden>false</Hidden>", "");
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
  });

  it("accepts the scheduler-elided idle requirement default", () => {
    const normalized = taskXml().replace("<RunOnlyIfIdle>false</RunOnlyIfIdle>", "");
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
  });

  it("accepts the scheduler-elided wake default", () => {
    const normalized = taskXml().replace("<WakeToRun>false</WakeToRun>", "");
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
  });

  it("accepts an omitted duplicate trigger SID after proving the principal SID", () => {
    const normalized = replaceOnce(taskXml(), `<UserId>${expectation.userSid}</UserId>`, "");
    expect(matchWindowsServiceTaskDefinition(normalized, expectation)).toEqual({ matches: true });
    const empty = replaceOnce(taskXml(), `<UserId>${expectation.userSid}</UserId>`, "<UserId />");
    expect(matchWindowsServiceTaskDefinition(empty, expectation)).toEqual({ matches: true });
  });

  it("rejects malformed XML and a changed task envelope", () => {
    expectMismatch("<Task><Actions></Task>", "invalid-xml");
    expectMismatch("<NotTask />", "task-root-mismatch");
    expectMismatch(
      taskXml().replace(
        "http://schemas.microsoft.com/windows/2004/02/mit/task",
        "urn:untrusted-task",
      ),
      "task-namespace-mismatch",
    );
    expectMismatch(taskXml().replace('version="1.2"', 'version="1.4"'), "task-version-mismatch");
    expectMismatch(
      taskXml()
        .replace(
          '<Actions Context="Author">',
          '<foreign:Actions xmlns:foreign="urn:foreign-task" Context="Author">',
        )
        .replace("</Actions>", "</foreign:Actions>"),
      "actions-count-mismatch",
    );
    expectMismatch(
      taskXml()
        .replace("<Command>", '<foreign:Command xmlns:foreign="urn:foreign-task">')
        .replace("</Command>", "</foreign:Command>"),
      "exec-command-count-mismatch",
    );
  });

  it("requires one action in the trusted context", () => {
    expectMismatch(
      taskXml().replace('Context="Author"', 'Context="Other"'),
      "actions-context-mismatch",
    );
    expectMismatch(taskXml().replace(/<Actions[^>]*>.*<\/Actions>/, ""), "actions-count-mismatch");
    expectMismatch(
      taskXml().replace("</Task>", '<Actions Context="Author"><Exec /></Actions></Task>'),
      "actions-count-mismatch",
    );
    expectMismatch(
      taskXml().replace(/<Exec>.*<\/Exec>/, "<ComHandler />"),
      "exec-action-count-mismatch",
    );
    expectMismatch(
      taskXml().replace("</Exec>", "</Exec><Exec><Command>other.exe</Command></Exec>"),
      "exec-action-count-mismatch",
    );
  });

  it("requires the exact absolute wscript command and quoted launcher argument", () => {
    const cases: ReadonlyArray<{
      readonly from: string;
      readonly reason: WindowsServiceTaskDefinitionMismatch;
      readonly to: string;
    }> = [
      {
        from: `<Command>${expectation.wscriptPath}</Command>`,
        reason: "exec-command-mismatch",
        to: "<Command>wscript.exe</Command>",
      },
      {
        from: `<Command>${expectation.wscriptPath}</Command>`,
        reason: "exec-command-mismatch",
        to: "<Command>C:\\Windows\\System32\\cscript.exe</Command>",
      },
      {
        from: `<Arguments>&quot;${expectation.launcherPath}&quot;</Arguments>`,
        reason: "exec-arguments-count-mismatch",
        to: "",
      },
      {
        from: `<Arguments>&quot;${expectation.launcherPath}&quot;</Arguments>`,
        reason: "exec-arguments-mismatch",
        to: `<Arguments>${expectation.launcherPath}</Arguments>`,
      },
      {
        from: `<Arguments>&quot;${expectation.launcherPath}&quot;</Arguments>`,
        reason: "exec-arguments-mismatch",
        to: `<Arguments>&quot;${expectation.launcherPath}&quot; /extra</Arguments>`,
      },
      {
        from: "</Exec>",
        reason: "exec-shape-mismatch",
        to: "<WorkingDirectory>C:\\</WorkingDirectory></Exec>",
      },
    ];
    for (const entry of cases) {
      expectMismatch(replaceOnce(taskXml(), entry.from, entry.to), entry.reason);
    }
  });

  it("requires one user principal with the exact security profile", () => {
    const cases: ReadonlyArray<{
      readonly from: string;
      readonly reason: WindowsServiceTaskDefinitionMismatch;
      readonly to: string;
    }> = [
      { from: 'id="Author"', reason: "principal-id-mismatch", to: 'id="Other"' },
      {
        from: `<Principal id="Author"><UserId>${expectation.userSid}</UserId>`,
        reason: "principal-sid-mismatch",
        to: '<Principal id="Author"><UserId>S-1-5-21-9999</UserId>',
      },
      {
        from: "<LogonType>InteractiveToken</LogonType>",
        reason: "principal-logon-type-mismatch",
        to: "<LogonType>Password</LogonType>",
      },
      {
        from: "<RunLevel>LeastPrivilege</RunLevel>",
        reason: "principal-run-level-mismatch",
        to: "<RunLevel>HighestAvailable</RunLevel>",
      },
      {
        from: "</Principal>",
        reason: "principal-process-token-sid-type-mismatch",
        to: "<ProcessTokenSidType>Unrestricted</ProcessTokenSidType></Principal>",
      },
      {
        from: "</Principal>",
        reason: "principal-shape-mismatch",
        to: "<GroupId>S-1-5-32-544</GroupId></Principal>",
      },
      {
        from: "</Principal>",
        reason: "principal-shape-mismatch",
        to: "<RequiredPrivileges><Privilege>SeDebugPrivilege</Privilege></RequiredPrivileges></Principal>",
      },
    ];
    for (const entry of cases) {
      expectMismatch(replaceOnce(taskXml(), entry.from, entry.to), entry.reason);
    }
    expectMismatch(
      taskXml().replace("</Principals>", '<Principal id="Other" /></Principals>'),
      "principal-count-mismatch",
    );
  });

  it("requires one enabled trigger bound to the expected user and mode", () => {
    const bootExpectation = { ...expectation, boot: true };
    expectMismatch(
      taskXml().replace(
        `<LogonTrigger><Enabled>true</Enabled><UserId>${expectation.userSid}</UserId></LogonTrigger>`,
        "<BootTrigger><Enabled>true</Enabled></BootTrigger>",
      ),
      "trigger-kind-mismatch",
    );
    expectMismatch(
      taskXml(bootExpectation).replace(
        "<BootTrigger><Enabled>true</Enabled></BootTrigger>",
        `<LogonTrigger><Enabled>true</Enabled><UserId>${expectation.userSid}</UserId></LogonTrigger>`,
      ),
      "trigger-kind-mismatch",
      bootExpectation,
    );
    expectMismatch(
      taskXml().replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>"),
      "trigger-enabled-mismatch",
    );
    const normalizedTriggerUser = taskXml().replace(
      `<UserId>${expectation.userSid}</UserId></LogonTrigger>`,
      "<UserId>runneradmin</UserId></LogonTrigger>",
    );
    expect(
      matchWindowsServiceTaskDefinition(normalizedTriggerUser, {
        ...expectation,
        triggerUserAliases: ["runneradmin"],
      }),
    ).toEqual({ matches: true });
    expectMismatch(
      taskXml().replace("</LogonTrigger>", "<Delay>PT1M</Delay></LogonTrigger>"),
      "trigger-shape-mismatch",
    );
    expectMismatch(
      taskXml().replace(
        "</Triggers>",
        "<BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>",
      ),
      "trigger-count-mismatch",
    );
  });

  it("requires the complete service lifecycle settings profile", () => {
    const cases: ReadonlyArray<{
      readonly from: string;
      readonly reason: WindowsServiceTaskDefinitionMismatch;
      readonly to: string;
    }> = [
      { from: "IgnoreNew", reason: "multiple-instances-policy-mismatch", to: "Parallel" },
      {
        from: "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        reason: "disallow-start-on-batteries-mismatch",
        to: "<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>",
      },
      {
        from: "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        reason: "stop-on-batteries-mismatch",
        to: "<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>",
      },
      {
        from: "<AllowHardTerminate>true</AllowHardTerminate>",
        reason: "allow-hard-terminate-mismatch",
        to: "<AllowHardTerminate>false</AllowHardTerminate>",
      },
      {
        from: "<StartWhenAvailable>true</StartWhenAvailable>",
        reason: "start-when-available-mismatch",
        to: "<StartWhenAvailable>false</StartWhenAvailable>",
      },
      {
        from: "<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
        reason: "run-only-if-network-available-mismatch",
        to: "<RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>",
      },
      {
        from: "<AllowStartOnDemand>true</AllowStartOnDemand>",
        reason: "allow-start-on-demand-mismatch",
        to: "<AllowStartOnDemand>false</AllowStartOnDemand>",
      },
      { from: "<Hidden>false</Hidden>", reason: "hidden-mismatch", to: "<Hidden>true</Hidden>" },
      {
        from: "<RunOnlyIfIdle>false</RunOnlyIfIdle>",
        reason: "run-only-if-idle-mismatch",
        to: "<RunOnlyIfIdle>true</RunOnlyIfIdle>",
      },
      {
        from: "<WakeToRun>false</WakeToRun>",
        reason: "wake-to-run-mismatch",
        to: "<WakeToRun>true</WakeToRun>",
      },
      {
        from: "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        reason: "execution-time-limit-mismatch",
        to: "<ExecutionTimeLimit>PT72H</ExecutionTimeLimit>",
      },
      { from: "<Priority>7</Priority>", reason: "priority-mismatch", to: "<Priority>4</Priority>" },
    ];
    for (const entry of cases) {
      expectMismatch(replaceOnce(taskXml(), entry.from, entry.to), entry.reason);
    }
    expectMismatch(
      taskXml().replace("<Enabled>true</Enabled><Hidden>", "<Enabled>false</Enabled><Hidden>"),
      "task-enabled-mismatch",
    );
  });

  it("allows only exact benign scheduler-export defaults", () => {
    const defaults =
      "<DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter><UseUnifiedSchedulingEngine>false</UseUnifiedSchedulingEngine><DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>";
    const exported = taskXml().replace("</Settings>", `${defaults}</Settings>`);
    expect(matchWindowsServiceTaskDefinition(exported, expectation)).toEqual({ matches: true });

    const cases: ReadonlyArray<{
      readonly from: string;
      readonly reason: WindowsServiceTaskDefinitionMismatch;
      readonly to: string;
    }> = [
      {
        from: "<DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter>",
        reason: "delete-expired-task-after-mismatch",
        to: "<DeleteExpiredTaskAfter>PT1H</DeleteExpiredTaskAfter>",
      },
      {
        from: "<UseUnifiedSchedulingEngine>false</UseUnifiedSchedulingEngine>",
        reason: "unified-scheduling-engine-mismatch",
        to: "<UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>",
      },
      {
        from: "<DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>",
        reason: "disallow-start-on-remote-session-mismatch",
        to: "<DisallowStartOnRemoteAppSession>true</DisallowStartOnRemoteAppSession>",
      },
    ];
    for (const entry of cases) {
      expectMismatch(replaceOnce(exported, entry.from, entry.to), entry.reason);
    }
  });

  it("requires the exact idle and restart policy shapes", () => {
    expectMismatch(
      taskXml().replace(
        "<StopOnIdleEnd>false</StopOnIdleEnd>",
        "<StopOnIdleEnd>true</StopOnIdleEnd>",
      ),
      "idle-stop-mismatch",
    );
    expectMismatch(
      taskXml().replace(
        "<RestartOnIdle>false</RestartOnIdle>",
        "<RestartOnIdle>true</RestartOnIdle>",
      ),
      "idle-restart-mismatch",
    );
    expectMismatch(
      taskXml().replace("</IdleSettings>", "<Duration>PT10M</Duration></IdleSettings>"),
      "idle-settings-shape-mismatch",
    );
    expectMismatch(
      taskXml().replace(
        "</IdleSettings>",
        "</IdleSettings><IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>",
      ),
      "idle-settings-count-mismatch",
    );
    expectMismatch(
      taskXml().replace("<Interval>PT1M</Interval>", "<Interval>PT5M</Interval>"),
      "restart-interval-mismatch",
    );
    expectMismatch(
      taskXml().replace("<Count>3</Count>", "<Count>1</Count>"),
      "restart-count-mismatch",
    );
    expectMismatch(
      taskXml().replace("</RestartOnFailure>", "<Extra>true</Extra></RestartOnFailure>"),
      "restart-on-failure-shape-mismatch",
    );
    expectMismatch(
      taskXml().replace(
        "</RestartOnFailure>",
        "</RestartOnFailure><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>",
      ),
      "restart-on-failure-count-mismatch",
    );
  });

  it("rejects missing, duplicate, and unexpected settings", () => {
    expectMismatch(taskXml().replace(/<Settings>.*<\/Settings>/, ""), "settings-count-mismatch");
    expectMismatch(
      taskXml().replace("</Task>", "<Settings><Enabled>true</Enabled></Settings></Task>"),
      "settings-count-mismatch",
    );
    expectMismatch(
      taskXml().replace(
        "</Settings>",
        "<NetworkProfileName>public</NetworkProfileName></Settings>",
      ),
      "settings-shape-mismatch",
    );
    expectMismatch(
      taskXml().replace("</Settings>", "<Enabled>true</Enabled></Settings>"),
      "task-enabled-mismatch",
    );
  });
});
