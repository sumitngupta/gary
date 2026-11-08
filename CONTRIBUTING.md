# Contributing

Issues and pull requests are welcome. For a large change, open an issue first so we can agree on the approach.

## Set up

Gary needs Node.js 22.13 or later.

```sh
npm ci
cp .env.example .env   # fill in at least the three required values
npm run dev
```

## Before you open a pull request

1. Run `npm run check`. It typechecks, runs the tests, and runs the scrub gate, which fails on home-directory paths, private IP addresses, real phone numbers, email addresses, and token-shaped strings.
2. Run `npm run build`.
3. Add a test for every behavior change. A test calls the code the way Gary does and asserts the exact result.
4. Keep each commit to one logical change, with a [Conventional Commits](https://www.conventionalcommits.org) subject such as `fix(web): ...`.

Never commit a real API key, token, phone number, or hostname. Use `example.com`, `555` phone numbers, and the documentation IP ranges in tests.

By contributing, you agree that your contribution is licensed under the Apache License 2.0.
