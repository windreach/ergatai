# Contributing to Ergatai

## Building from Source

Prerequisites: Bun, Python, Xcode Command Line Tools (macOS)

```bash
bun install
bun run dev      # Development with hot reload
bun run build    # Production build
bun run package:mac  # Create distributable
```

## Open Source vs Hosted Version

This is the open-source version of Ergatai. Local agent features work without a hosted backend.

## Analytics & Telemetry

Analytics (PostHog) and error tracking (Sentry) are **disabled by default** in open source builds. They only activate if you set the environment variables in `.env.local`.

## Contributing

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Submit a PR

Join our [Discord](https://discord.gg/8ektTZGnj4) for discussions.

## License

Apache 2.0
