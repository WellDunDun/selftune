# FOSS Launch Playbook Tracker

Manual actions for maximizing selftune's open-source impact. Check items off as completed.

---

## Service Signups

- [ ] [Socket.dev](https://socket.dev) — Supply chain security monitoring
- [ ] [SonarCloud](https://sonarcloud.io) — Free static analysis for public repos
- [ ] [Codecov](https://codecov.io) — Code coverage reporting
- [ ] [Sentry](https://sentry.io/for/open-source/) — Error tracking (free for OSS)
- [ ] [Thanks.dev](https://thanks.dev) — Dependency funding attribution
- [x] Publish to npm — `npm publish --provenance --access public`
- [x] Verify npm Trusted Publishing (OIDC) is configured for this repository/package

---

## Program Applications

- [ ] [GitHub Accelerator](https://accelerator.github.com) — Funding + mentorship for OSS maintainers
- [ ] [Secure Open Source Fund](https://openssf.org/community/fund/) — OpenSSF security funding
- [ ] [Tidelift](https://tidelift.com/about/lifter) — Enterprise subscription revenue for maintainers
- [ ] [NLnet Foundation](https://nlnet.nl/propose/) — European open-source grants
- [ ] [Sovereign Tech Fund](https://sovereigntechfund.de) — German government OSS infrastructure funding
- [ ] [MOSS (Mozilla)](https://www.mozilla.org/en-US/moss/) — Mozilla Open Source Support awards

---

## Awesome List Submissions

| List | Category | One-liner |
|------|----------|-----------|
| [awesome-cli-apps](https://github.com/agarrharr/awesome-cli-apps) | Developer Tools | Self-improving skills CLI for AI agents |
| [awesome-bun](https://github.com/apvarun/awesome-bun) | CLI Tools | TypeScript CLI built on Bun |
| [awesome-typescript](https://github.com/dzharii/awesome-typescript) | CLI | CLI for AI skill improvement |
| [awesome-ai-agents](https://github.com/e2b-dev/awesome-ai-agents) | Developer Tools | Continuous improvement for agent skills |
| [awesome-claude](https://github.com/anthropics/anthropic-cookbook) | Tools | Self-improving skills for Claude Code |
| [awesome-devtools](https://github.com/moimikey/awesome-devtools) | CLI | Self-improving agent skills |
| [awesome-testing](https://github.com/TheJambo/awesome-testing) | Tools | Eval generation from real usage |
| [awesome-open-source](https://github.com/cornelius/awesome-open-source) | Tools | OSS self-improving skills for AI agents |
| [awesome-llm](https://github.com/Hannibal046/Awesome-LLM) | Tools | LLM agent skill tuning |

---

## Newsletter Pitches

| Newsletter | URL | Pitch Angle |
|------------|-----|-------------|
| TLDR | https://tldr.tech/submit | AI agent skills that learn how you work — and fix themselves |
| Console.dev | https://console.dev/submit | Developer tool for AI skill improvement |
| Changelog | https://changelog.com/submit | OSS CLI that watches and improves agent skills |
| Hacker Newsletter | https://hackernewsletter.com | Show HN: selftune — skills that learn how you work |
| TypeScript Weekly | https://typescript-weekly.com | Bun + TypeScript CLI for agent eval |
| Node Weekly | https://nodeweekly.com/submit | CLI tool: observe, grade, and evolve AI skills |
| AI Weekly | https://aiweekly.co/submit | Continuous improvement loop for LLM agent skills |
| DevOps Weekly | https://devopsweekly.com | Self-improving AI agent skills — observe, evolve, deploy |
| The Pragmatic Engineer | https://newsletter.pragmaticengineer.com | Self-improving AI skills — a new category |

---

## Conference CFPs

| Conference | Relevance | URL |
|------------|-----------|-----|
| NodeConf EU | Bun/TypeScript CLI tooling | https://www.nodeconf.eu |
| AI Engineer Summit | Self-improving AI agent skills | https://www.ai.engineer |
| Open Source Summit | OSS project showcase | https://events.linuxfoundation.org |
| TypeScript Congress | TypeScript CLI architecture | https://typescriptcongress.com |
| DevOpsDays | Self-improving skills for AI agents | https://devopsdays.org |
| JSConf | JavaScript/TypeScript tooling | https://jsconf.com |

---

## Reddit & Social

### Subreddits

- [ ] r/typescript — Focus on Bun + TypeScript CLI architecture
- [ ] r/node — CLI tooling angle
- [ ] r/MachineLearning — Eval and grading methodology
- [ ] r/artificial — AI agent improvement
- [ ] r/ClaudeAI — Claude Code skill improvement
- [ ] r/commandline — CLI tool showcase
- [ ] r/opensource — OSS project launch

### Twitter/X

**Hashtags:** #TypeScript #CLI #AI #Agents #ClaudeCode #SelfImproving #DevTools #OpenSource

**Accounts to tag:** @bunikiofficial @anthropikiofficial @OpenCodeHQ

---

## Launch Day Runbook

### T-7 (One Week Before)

- [ ] Verify all CI workflows pass on main
- [ ] Publish the current release version to npm
- [ ] Verify npm package installs cleanly: `npx selftune --help`
- [ ] Write Show HN post draft
- [ ] Write Twitter/X thread draft
- [ ] Prepare demo GIF/video showing the observe-evolve loop

### T-1 (Day Before)

- [ ] Final `make check` on main
- [ ] Verify all README badges render correctly
- [ ] Verify SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md are linked
- [ ] Pre-write Reddit posts for each subreddit
- [ ] Queue newsletter submissions

### Launch Day

- [ ] Post to Hacker News (Show HN)
- [ ] Post to all target subreddits
- [ ] Publish Twitter/X thread
- [ ] Submit to newsletters
- [ ] Submit PRs to awesome lists
- [ ] Monitor HN comments and respond

### T+1 (Day After)

- [ ] Review analytics (npm downloads, GitHub stars, traffic)
- [ ] Respond to GitHub issues and discussions
- [ ] Follow up on newsletter submissions
- [ ] Submit to remaining awesome lists if not done
- [ ] Apply to funding programs
