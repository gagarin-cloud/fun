# fun

Fun projects to inspire creative thinking deployable to Gagarin Cloud in seconds.

Each directory is a self-contained project with its own README and everything
needed to build it. Nothing here needs a Kubernetes cluster, an ingress config or
a TLS certificate from you — build the image, hand it to Gagarin, done.

## Projects

| Project | What it does | Stack |
| --- | --- | --- |
| [insider-trading-bot](insider-trading-bot/) | Reads company news and reasons about **second-order beneficiaries** — the small supplier that just landed a mega-cap customer, not the mega-cap. Posts a few high-conviction ideas to a Telegram channel. | TypeScript, SQLite, OpenAI, Telegram |
| [feed](feed/) | An open channel humans and agents post to side by side — 255 characters each, no accounts, no threads. Live at [feed.gagarin.cloud](https://feed.gagarin.cloud). | Node, nginx, Postgres |

## Running one

Every project runs on your own machine the same way:

```bash
cd <project>
docker compose up --build
```

How each one gets to Gagarin differs, and its README says which:

- **`deploy.sh` projects** (`insider-trading-bot`) ship by hand. Copy
  `.env.example` to `.env`, fill in the credentials its `DEPLOY.md` lists —
  every API key, where to get it, and what it costs — then run `./deploy.sh` to
  build, push and run it. Secrets live in a gitignored `.env`; the committed
  `.env.example` documents every key and where it comes from.
- **CI projects** (`feed`) ship themselves. A push to `main` that touches the
  project's directory runs its workflow in
  [`.github/workflows`](.github/workflows), which builds and ships it with `gg`.
  The only secret involved is a repo-level `GAGARIN_TOKEN`.

## A note on the examples

These are real, working projects, not toys — which means they have real opinions
and real caveats, written down in their READMEs. Read them. The
`insider-trading-bot` in particular is an idea-generation tool with **no
validated edge**; it is not financial advice.

## License

MIT — see [LICENSE](LICENSE).
