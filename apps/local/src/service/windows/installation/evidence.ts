import { DOMParser } from "@xmldom/xmldom";

import {
  authorityMatch,
  authorityMismatch,
  type AuthorityMatch,
} from "../../authority/evidence.js";
import { canonicalWindowsPathIdentity } from "./model.js";

const WINDOWS_TASK_NAMESPACE = "http://schemas.microsoft.com/windows/2004/02/mit/task";

export interface WindowsServiceTaskDefinitionExpectation {
  readonly boot: boolean;
  readonly launcherPath: string;
  readonly userSid: string;
  readonly wscriptPath: string;
}

export type WindowsServiceTaskDefinitionMismatch =
  | "actions-context-mismatch"
  | "actions-count-mismatch"
  | "allow-hard-terminate-mismatch"
  | "allow-start-on-demand-mismatch"
  | "delete-expired-task-after-mismatch"
  | "disallow-start-on-batteries-mismatch"
  | "disallow-start-on-remote-session-mismatch"
  | "exec-action-count-mismatch"
  | "exec-arguments-count-mismatch"
  | "exec-arguments-mismatch"
  | "exec-command-count-mismatch"
  | "exec-command-mismatch"
  | "exec-shape-mismatch"
  | "execution-time-limit-mismatch"
  | "hidden-mismatch"
  | "idle-restart-mismatch"
  | "idle-settings-count-mismatch"
  | "idle-settings-shape-mismatch"
  | "idle-stop-mismatch"
  | "invalid-xml"
  | "logon-trigger-sid-mismatch"
  | "multiple-instances-policy-mismatch"
  | "principal-count-mismatch"
  | "principal-id-mismatch"
  | "principal-logon-type-mismatch"
  | "principal-run-level-mismatch"
  | "principal-shape-mismatch"
  | "principal-sid-mismatch"
  | "principals-count-mismatch"
  | "priority-mismatch"
  | "restart-count-mismatch"
  | "restart-interval-mismatch"
  | "restart-on-failure-count-mismatch"
  | "restart-on-failure-shape-mismatch"
  | "run-only-if-idle-mismatch"
  | "run-only-if-network-available-mismatch"
  | "settings-count-mismatch"
  | "settings-shape-mismatch"
  | "start-when-available-mismatch"
  | "stop-on-batteries-mismatch"
  | "task-enabled-mismatch"
  | "task-namespace-mismatch"
  | "task-root-mismatch"
  | "task-version-mismatch"
  | "trigger-enabled-mismatch"
  | "trigger-count-mismatch"
  | "trigger-kind-mismatch"
  | "trigger-shape-mismatch"
  | "triggers-count-mismatch"
  | "unified-scheduling-engine-mismatch"
  | "wake-to-run-mismatch";

export type WindowsServiceTaskDefinitionMatch =
  AuthorityMatch<WindowsServiceTaskDefinitionMismatch>;

export type WindowsServiceTaskPrincipalScope =
  | { readonly _tag: "CurrentUser" }
  | { readonly _tag: "DifferentUser" }
  | { readonly _tag: "Invalid" };

function mismatch(reason: WindowsServiceTaskDefinitionMismatch): WindowsServiceTaskDefinitionMatch {
  return authorityMismatch(reason);
}

function nodeLocalName(node: Node): string {
  const separator = node.nodeName.indexOf(":");
  return separator < 0 ? node.nodeName : node.nodeName.slice(separator + 1);
}

function descendantElements(parent: Document | Element, name: string): ReadonlyArray<Element> {
  return Array.from(parent.getElementsByTagNameNS(WINDOWS_TASK_NAMESPACE, name));
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function directElementChildren(parent: Node): ReadonlyArray<Element> {
  const children: Element[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const child = parent.childNodes.item(index);
    if (child !== null && isElement(child)) children.push(child);
  }
  return children;
}

function directChildrenNamed(parent: Node, name: string): ReadonlyArray<Element> {
  return directElementChildren(parent).filter(
    (child) => child.namespaceURI === WINDOWS_TASK_NAMESPACE && nodeLocalName(child) === name,
  );
}

function nodeText(node: Node): string {
  return node.textContent ?? "";
}

function hasExactChildren(parent: Node, names: ReadonlyArray<string>): boolean {
  const children = directElementChildren(parent);
  if (children.some((child) => child.namespaceURI !== WINDOWS_TASK_NAMESPACE)) return false;
  const actual = children.map(nodeLocalName);
  return (
    actual.length === names.length &&
    names.every((name) => actual.filter((candidate) => candidate === name).length === 1)
  );
}

function hasExpectedChildren(
  parent: Node,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
): boolean {
  const children = directElementChildren(parent);
  if (children.some((child) => child.namespaceURI !== WINDOWS_TASK_NAMESPACE)) return false;
  const actual = children.map(nodeLocalName);
  const allowed = new Set([...required, ...optional]);
  return (
    actual.every((name) => allowed.has(name)) &&
    actual.every((name) => actual.filter((candidate) => candidate === name).length === 1) &&
    required.every((name) => actual.includes(name))
  );
}

function hasSingleTextChild(parent: Node, name: string, expected: string): boolean {
  const children = directChildrenNamed(parent, name);
  return children.length === 1 && nodeText(children[0]).trim() === expected;
}

function hasOptionalTextChild(parent: Node, name: string, expected: string): boolean {
  const children = directChildrenNamed(parent, name);
  return (
    children.length === 0 || (children.length === 1 && nodeText(children[0]).trim() === expected)
  );
}

function sameSid(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
}

function quotedWindowsPath(value: string): string | null {
  const match = /^"([^"\r\n]+)"$/.exec(value);
  if (!match) return null;
  return canonicalWindowsPathIdentity(match[1]);
}

function sameWindowsExecutable(
  left: string,
  right: string,
  allowRelativeWscript: boolean,
): boolean {
  const expectedAbsolute = canonicalWindowsPathIdentity(right);
  if (expectedAbsolute !== null) {
    return canonicalWindowsPathIdentity(left) === expectedAbsolute;
  }
  return (
    allowRelativeWscript &&
    right === "wscript.exe" &&
    left.trim().toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
  );
}

export function inspectWindowsServiceTaskPrincipalScope(
  xml: string,
  currentUserSid: string,
): WindowsServiceTaskPrincipalScope {
  const parseErrors: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      error: (message) => parseErrors.push(String(message)),
      fatalError: (message) => parseErrors.push(String(message)),
      warning: (message) => parseErrors.push(String(message)),
    },
  }).parseFromString(xml, "application/xml");
  if (
    parseErrors.length > 0 ||
    !document.documentElement ||
    nodeLocalName(document.documentElement) !== "Task" ||
    document.documentElement.namespaceURI !== WINDOWS_TASK_NAMESPACE
  ) {
    return { _tag: "Invalid" };
  }
  const principals = descendantElements(document, "Principals");
  if (principals.length !== 1) return { _tag: "Invalid" };
  const principalNodes = directChildrenNamed(principals[0], "Principal");
  if (principalNodes.length !== 1) return { _tag: "Invalid" };
  const userIds = directChildrenNamed(principalNodes[0], "UserId");
  if (userIds.length !== 1) return { _tag: "Invalid" };
  return sameSid(nodeText(userIds[0]), currentUserSid)
    ? { _tag: "CurrentUser" }
    : { _tag: "DifferentUser" };
}

function matchRequiredWindowsServiceTaskSettings(
  settings: Element,
): WindowsServiceTaskDefinitionMatch {
  if (!hasSingleTextChild(settings, "MultipleInstancesPolicy", "IgnoreNew")) {
    return mismatch("multiple-instances-policy-mismatch");
  }
  if (!hasSingleTextChild(settings, "DisallowStartIfOnBatteries", "false")) {
    return mismatch("disallow-start-on-batteries-mismatch");
  }
  if (!hasSingleTextChild(settings, "StopIfGoingOnBatteries", "false")) {
    return mismatch("stop-on-batteries-mismatch");
  }
  if (!hasSingleTextChild(settings, "StartWhenAvailable", "true")) {
    return mismatch("start-when-available-mismatch");
  }
  if (!hasSingleTextChild(settings, "ExecutionTimeLimit", "PT0S")) {
    return mismatch("execution-time-limit-mismatch");
  }
  if (!hasSingleTextChild(settings, "Enabled", "true")) {
    return mismatch("task-enabled-mismatch");
  }
  const restartNodes = directChildrenNamed(settings, "RestartOnFailure");
  if (restartNodes.length !== 1) return mismatch("restart-on-failure-count-mismatch");
  const restart = restartNodes[0];
  if (!hasSingleTextChild(restart, "Interval", "PT1M")) {
    return mismatch("restart-interval-mismatch");
  }
  if (!hasSingleTextChild(restart, "Count", "3")) {
    return mismatch("restart-count-mismatch");
  }
  return hasExactChildren(restart, ["Interval", "Count"])
    ? authorityMatch()
    : mismatch("restart-on-failure-shape-mismatch");
}

function matchModernWindowsServiceTaskSettings(
  settings: Element,
): WindowsServiceTaskDefinitionMatch {
  const required = matchRequiredWindowsServiceTaskSettings(settings);
  if (!required.matches) return required;
  if (!hasSingleTextChild(settings, "AllowHardTerminate", "true")) {
    return mismatch("allow-hard-terminate-mismatch");
  }
  if (!hasSingleTextChild(settings, "RunOnlyIfNetworkAvailable", "false")) {
    return mismatch("run-only-if-network-available-mismatch");
  }
  const idleSettingsNodes = directChildrenNamed(settings, "IdleSettings");
  if (idleSettingsNodes.length !== 1) return mismatch("idle-settings-count-mismatch");
  const idleSettings = idleSettingsNodes[0];
  if (!hasSingleTextChild(idleSettings, "StopOnIdleEnd", "false")) {
    return mismatch("idle-stop-mismatch");
  }
  if (!hasSingleTextChild(idleSettings, "RestartOnIdle", "false")) {
    return mismatch("idle-restart-mismatch");
  }
  if (!hasExactChildren(idleSettings, ["StopOnIdleEnd", "RestartOnIdle"])) {
    return mismatch("idle-settings-shape-mismatch");
  }
  if (!hasSingleTextChild(settings, "AllowStartOnDemand", "true")) {
    return mismatch("allow-start-on-demand-mismatch");
  }
  if (!hasSingleTextChild(settings, "Hidden", "false")) return mismatch("hidden-mismatch");
  if (!hasSingleTextChild(settings, "RunOnlyIfIdle", "false")) {
    return mismatch("run-only-if-idle-mismatch");
  }
  if (!hasSingleTextChild(settings, "WakeToRun", "false")) {
    return mismatch("wake-to-run-mismatch");
  }
  if (!hasSingleTextChild(settings, "Priority", "7")) return mismatch("priority-mismatch");
  if (!hasOptionalTextChild(settings, "DeleteExpiredTaskAfter", "PT0S")) {
    return mismatch("delete-expired-task-after-mismatch");
  }
  if (!hasOptionalTextChild(settings, "UseUnifiedSchedulingEngine", "false")) {
    return mismatch("unified-scheduling-engine-mismatch");
  }
  if (!hasOptionalTextChild(settings, "DisallowStartOnRemoteAppSession", "false")) {
    return mismatch("disallow-start-on-remote-session-mismatch");
  }
  return hasExpectedChildren(
    settings,
    [
      "MultipleInstancesPolicy",
      "DisallowStartIfOnBatteries",
      "StopIfGoingOnBatteries",
      "AllowHardTerminate",
      "StartWhenAvailable",
      "RunOnlyIfNetworkAvailable",
      "IdleSettings",
      "AllowStartOnDemand",
      "Enabled",
      "Hidden",
      "RunOnlyIfIdle",
      "WakeToRun",
      "RestartOnFailure",
      "ExecutionTimeLimit",
      "Priority",
    ],
    ["DeleteExpiredTaskAfter", "UseUnifiedSchedulingEngine", "DisallowStartOnRemoteAppSession"],
  )
    ? authorityMatch()
    : mismatch("settings-shape-mismatch");
}

function matchLegacyWindowsServiceTaskSettings(
  settings: Element,
): WindowsServiceTaskDefinitionMatch {
  const required = matchRequiredWindowsServiceTaskSettings(settings);
  if (!required.matches) return required;
  const optionalValues: ReadonlyArray<
    readonly [string, string, WindowsServiceTaskDefinitionMismatch]
  > = [
    ["AllowHardTerminate", "true", "allow-hard-terminate-mismatch"],
    ["RunOnlyIfNetworkAvailable", "false", "run-only-if-network-available-mismatch"],
    ["AllowStartOnDemand", "true", "allow-start-on-demand-mismatch"],
    ["Hidden", "false", "hidden-mismatch"],
    ["RunOnlyIfIdle", "false", "run-only-if-idle-mismatch"],
    ["WakeToRun", "false", "wake-to-run-mismatch"],
    ["Priority", "7", "priority-mismatch"],
    ["DeleteExpiredTaskAfter", "PT0S", "delete-expired-task-after-mismatch"],
    ["UseUnifiedSchedulingEngine", "false", "unified-scheduling-engine-mismatch"],
    ["DisallowStartOnRemoteAppSession", "false", "disallow-start-on-remote-session-mismatch"],
  ];
  for (const [name, value, reason] of optionalValues) {
    if (!hasOptionalTextChild(settings, name, value)) return mismatch(reason);
  }
  const idleSettingsNodes = directChildrenNamed(settings, "IdleSettings");
  if (idleSettingsNodes.length > 1) return mismatch("idle-settings-count-mismatch");
  if (idleSettingsNodes.length === 1) {
    const idleSettings = idleSettingsNodes[0];
    if (!hasSingleTextChild(idleSettings, "StopOnIdleEnd", "true")) {
      return mismatch("idle-stop-mismatch");
    }
    if (!hasSingleTextChild(idleSettings, "RestartOnIdle", "false")) {
      return mismatch("idle-restart-mismatch");
    }
    if (!hasExactChildren(idleSettings, ["StopOnIdleEnd", "RestartOnIdle"])) {
      return mismatch("idle-settings-shape-mismatch");
    }
  }
  return hasExpectedChildren(
    settings,
    [
      "MultipleInstancesPolicy",
      "DisallowStartIfOnBatteries",
      "StopIfGoingOnBatteries",
      "StartWhenAvailable",
      "RestartOnFailure",
      "ExecutionTimeLimit",
      "Enabled",
    ],
    [
      "AllowHardTerminate",
      "RunOnlyIfNetworkAvailable",
      "IdleSettings",
      "AllowStartOnDemand",
      "Hidden",
      "RunOnlyIfIdle",
      "WakeToRun",
      "Priority",
      "DeleteExpiredTaskAfter",
      "UseUnifiedSchedulingEngine",
      "DisallowStartOnRemoteAppSession",
    ],
  )
    ? authorityMatch()
    : mismatch("settings-shape-mismatch");
}

function matchWindowsServiceTaskDefinitionWithSettings(
  xml: string,
  expectation: WindowsServiceTaskDefinitionExpectation,
  matchSettings: (settings: Element) => WindowsServiceTaskDefinitionMatch,
  allowRelativeWscript: boolean,
): WindowsServiceTaskDefinitionMatch {
  const parseErrors: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      error: (message) => parseErrors.push(String(message)),
      fatalError: (message) => parseErrors.push(String(message)),
      warning: (message) => parseErrors.push(String(message)),
    },
  }).parseFromString(xml, "application/xml");
  if (parseErrors.length > 0) return mismatch("invalid-xml");
  if (!document.documentElement || nodeLocalName(document.documentElement) !== "Task") {
    return mismatch("task-root-mismatch");
  }
  if (document.documentElement.namespaceURI !== WINDOWS_TASK_NAMESPACE) {
    return mismatch("task-namespace-mismatch");
  }
  if (document.documentElement.getAttribute("version") !== "1.2") {
    return mismatch("task-version-mismatch");
  }

  const actions = descendantElements(document, "Actions");
  if (actions.length !== 1) return mismatch("actions-count-mismatch");
  if (actions[0].getAttribute("Context") !== "Author") {
    return mismatch("actions-context-mismatch");
  }
  const actionChildren = directElementChildren(actions[0]);
  if (
    actionChildren.length !== 1 ||
    actionChildren[0].namespaceURI !== WINDOWS_TASK_NAMESPACE ||
    nodeLocalName(actionChildren[0]) !== "Exec"
  ) {
    return mismatch("exec-action-count-mismatch");
  }
  const exec = actionChildren[0];
  const commands = directChildrenNamed(exec, "Command");
  if (commands.length !== 1) return mismatch("exec-command-count-mismatch");
  if (
    !sameWindowsExecutable(
      nodeText(commands[0]).trim(),
      expectation.wscriptPath,
      allowRelativeWscript,
    )
  ) {
    return mismatch("exec-command-mismatch");
  }
  const argumentsNodes = directChildrenNamed(exec, "Arguments");
  if (argumentsNodes.length !== 1) return mismatch("exec-arguments-count-mismatch");
  const expectedLauncher = canonicalWindowsPathIdentity(expectation.launcherPath);
  if (
    expectedLauncher === null ||
    quotedWindowsPath(nodeText(argumentsNodes[0])) !== expectedLauncher
  ) {
    return mismatch("exec-arguments-mismatch");
  }
  if (!hasExactChildren(exec, ["Command", "Arguments"])) {
    return mismatch("exec-shape-mismatch");
  }

  const principals = descendantElements(document, "Principals");
  if (principals.length !== 1) return mismatch("principals-count-mismatch");
  const principalNodes = directChildrenNamed(principals[0], "Principal");
  if (principalNodes.length !== 1) return mismatch("principal-count-mismatch");
  const principal = principalNodes[0];
  if (principal.getAttribute("id") !== "Author") return mismatch("principal-id-mismatch");
  if (!hasExpectedChildren(principal, ["UserId", "LogonType", "RunLevel"], ["DisplayName"])) {
    return mismatch("principal-shape-mismatch");
  }
  const principalUserIds = directChildrenNamed(principal, "UserId");
  if (
    principalUserIds.length !== 1 ||
    !sameSid(nodeText(principalUserIds[0]), expectation.userSid)
  ) {
    return mismatch("principal-sid-mismatch");
  }
  const expectedLogonType = expectation.boot ? "S4U" : "InteractiveToken";
  if (!hasSingleTextChild(principal, "LogonType", expectedLogonType)) {
    return mismatch("principal-logon-type-mismatch");
  }
  const expectedRunLevel = expectation.boot ? "HighestAvailable" : "LeastPrivilege";
  if (!hasSingleTextChild(principal, "RunLevel", expectedRunLevel)) {
    return mismatch("principal-run-level-mismatch");
  }
  const triggers = descendantElements(document, "Triggers");
  if (triggers.length !== 1) return mismatch("triggers-count-mismatch");
  const triggerNodes = directElementChildren(triggers[0]);
  if (triggerNodes.length !== 1) return mismatch("trigger-count-mismatch");
  const expectedTrigger = expectation.boot ? "BootTrigger" : "LogonTrigger";
  if (
    triggerNodes[0].namespaceURI !== WINDOWS_TASK_NAMESPACE ||
    nodeLocalName(triggerNodes[0]) !== expectedTrigger
  ) {
    return mismatch("trigger-kind-mismatch");
  }
  const trigger = triggerNodes[0];
  const expectedTriggerShape = expectation.boot ? ["Enabled"] : ["Enabled", "UserId"];
  if (!hasSingleTextChild(trigger, "Enabled", "true")) {
    return mismatch("trigger-enabled-mismatch");
  }
  if (!expectation.boot) {
    const triggerUserIds = directChildrenNamed(trigger, "UserId");
    if (triggerUserIds.length !== 1 || !sameSid(nodeText(triggerUserIds[0]), expectation.userSid)) {
      return mismatch("logon-trigger-sid-mismatch");
    }
  }
  if (!hasExactChildren(trigger, expectedTriggerShape)) {
    return mismatch("trigger-shape-mismatch");
  }

  const settingsNodes = descendantElements(document, "Settings");
  if (settingsNodes.length !== 1) return mismatch("settings-count-mismatch");
  return matchSettings(settingsNodes[0]);
}

export function matchWindowsServiceTaskDefinition(
  xml: string,
  expectation: WindowsServiceTaskDefinitionExpectation,
): WindowsServiceTaskDefinitionMatch {
  return matchWindowsServiceTaskDefinitionWithSettings(
    xml,
    expectation,
    matchModernWindowsServiceTaskSettings,
    false,
  );
}

export function matchLegacyWindowsServiceTaskDefinition(
  xml: string,
  expectation: WindowsServiceTaskDefinitionExpectation,
): WindowsServiceTaskDefinitionMatch {
  return matchWindowsServiceTaskDefinitionWithSettings(
    xml,
    expectation,
    matchLegacyWindowsServiceTaskSettings,
    true,
  );
}
