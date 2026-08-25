Pi extensions and skills repo. No build step. Verify types: `npm run check`. Run `npm run test:quick` by default. For `extensions/workspace` changes, run the affected workspace test because `test:quick` excludes workspace tests. Run `npm test` only when full-suite coverage is necessary.

Use ASD-STE100 style for all technical prose, including documentation and code comments; preserve code, identifiers, literals, quotations, and fixed API/UI terms.

When implementing skills and extensions, treat context efficiency as a primary design constraint without sacrificing effectiveness. Keep always-loaded metadata, prompts, and tool output concise; use progressive disclosure and on-demand reads for detail; and avoid injecting redundant, low-value, or readily discoverable information into model context.

Support only MacOS and Linux.

Do not use the `.pi` directory in this repo.
