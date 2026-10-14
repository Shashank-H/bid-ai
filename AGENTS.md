# Project planning convention

- Use `docs/requirements/Full-Requirements.md` as the requirements source for phase plans.
- Store each phase plan under `docs/requirements/phase N/` (for example, `docs/requirements/phase 1/PLAN.md` and `docs/requirements/phase 2/PLAN.md`).
- Keep all documentation related to a phase in that phase's dedicated folder under `docs/requirements/phase N/`.
- Keep overall, cross-phase documentation in `docs/architecture-and-implementation/`.
- Keep all documentation specific to a phase inside that phase's dedicated folder under `docs/requirements/phase N/`.
- Keep overall, cross-phase project documentation under `docs/architecture-and-implementation/`.
- Every code you generate should have logical seperation (empty newline) between lines of code for ex: A set of code does initialization, a set of code does some other thing. same thing between each function.
- Keep `README.md` concise and project-wide: describe the product, overall architecture, what is currently implemented, and how to run/check it. Do not turn it into a phase-by-phase progress report; link to requirements and architecture docs for detail. Update it when implemented capabilities or setup instructions materially change.
- Speed is paramount, unit tests are not necessary, but e2e tests can be present to test core changes and implementations.
- Do not add or run E2E tests for small UI changes. Use focused build/typechecks instead; reserve E2E testing for core behavior changes or when explicitly requested.
