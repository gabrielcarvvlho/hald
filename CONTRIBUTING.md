# Contributing to Hald

Thanks for your interest in contributing. Hald is an open-source project and we welcome contributions of all kinds.

## Getting Started

```bash
git clone https://github.com/gabrielcarvvlho/hald.git
cd hald
npm install
npm run build
npm test
```

## Development

- **TypeScript** with strict mode
- **vitest** for testing
- **eslint + prettier** for formatting
- **tsup** for building

### Commands

```bash
npm run build        # Build with tsup
npm run dev          # Build in watch mode
npm test             # Run all tests
npm run lint         # Lint + type check
npm run format       # Format with prettier
```

### Testing

Write tests for any new functionality. We use vitest:

```bash
npm test                          # All tests
npx vitest run tests/path/file    # Specific test file
npx vitest --watch                # Watch mode
```

## Pull Requests

1. Fork the repo and create a feature branch from `main`
2. Write tests for your changes
3. Ensure all tests pass (`npm test`)
4. Ensure linting passes (`npm run lint`)
5. Write clear commit messages using conventional commits (`feat:`, `fix:`, `docs:`, etc.)
6. Open a PR with a clear description of what and why

## Reporting Issues

Use GitHub Issues. Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Node version, LLM provider)

## Code of Conduct

Be respectful and constructive. We're all here to build something useful.
