# fun

Fun projects to inspire creative thinking deployable to Gagarin Cloud in seconds.

Each directory is a self-contained project with its own README, `.env.example`
and `Dockerfile`. Nothing here needs a Kubernetes cluster, an ingress config or
a TLS certificate from you — build the image, hand it to Gagarin, done.

## Projects

| Project | What it does | Stack |
| --- | --- | --- |
| [insider-trading-bot](insider-trading-bot/) | Reads company news and reasons about **second-order beneficiaries** — the small supplier that just landed a mega-cap customer, not the mega-cap. Posts a few high-conviction ideas to a Telegram channel. | TypeScript, SQLite, OpenAI, Telegram |

## Running one

```bash
cd <project>
cp .env.example .env    # fill in the credentials its DEPLOY.md lists
./deploy.sh             # build, push and run it on Gagarin Cloud
```

Each project ships a `DEPLOY.md` that starts from zero — every API key, where to
get it, and what it costs — plus a `deploy.sh` that does the whole deploy once
`.env` is filled in. Run `docker compose up` instead if you'd rather keep it on
your own machine.

Secrets live in a gitignored `.env`; the committed `.env.example` documents every
key and where it comes from.

## A note on the examples

These are real, working projects, not toys — which means they have real opinions
and real caveats, written down in their READMEs. Read them. The
`insider-trading-bot` in particular is an idea-generation tool with **no
validated edge**; it is not financial advice.

## License

MIT — see [LICENSE](LICENSE).
