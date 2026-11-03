---
name: Publish package
about: Track publishing a package to npm
title: 'Publish: <package-name> to npm'
labels: release,devops
assignees: ''
---

## Package

**Name:** <package-name>
**Scope:** <@scope> or (none)

## Prerequisites

- [ ] Package.json has correct name, version, description, repository, license
- [ ] Build outputs to `dist/` (or equivalent)
- [ ] `files` field in package.json lists only publishable artifacts
- [ ] `.npmignore` excludes source, tests, docs, etc.
- [ ] README.md is present and renders correctly
- [ ] CHANGELOG.md exists
- [ ] LICENSE file present
- [ ] GitHub Actions workflow for publish (or manual process documented)

## Release checklist

- [ ] Version bump (semver: patch/minor/major)
- [ ] Changelog updated
- [ ] Git tag created: `vX.Y.Z`
- [ ] GitHub Release created with notes
- [ ] `npm publish` (or `bun publish`) succeeds
- [ ] Verify on npmjs.com

## Post-publish

- [ ] Update OpenCode plugin docs with install instructions
- [ ] Test fresh install in a clean project
- [ ] Update any dependent projects
