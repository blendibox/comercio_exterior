# Blendibox Sourcing · China

Sistema de apoio à decisão para a Blendibox encontrar fábricas de **bolsas puffer na China**, avaliar fornecedores, simular o **custo de importação** e consultar **dados oficiais de importação ao vivo** (Comex Stat/MDIC).

- **Frontend:** site estático em [`docs/`](docs/) → publicado no **GitHub Pages**.
- **Backend:** **Cloudflare Worker** em [`worker/`](worker/) → proxy do Comex Stat (CORS + cache), **contas de usuário** (cadastro, login e recuperação de senha por e‑mail via **Resend**) e rastreador de fornecedores no **KV**.

```
┌─────────────────────┐        ┌──────────────────────────┐        ┌──────────────────────┐
│  GitHub Pages        │  fetch │  Cloudflare Worker        │  POST  │  API Comex Stat (MDIC)│
│  docs/index.html     ├───────►│  /api/comexstat           ├───────►│  api-comexstat...     │
│  (site estático)     │        │  /api/suppliers  ──► KV   │        └──────────────────────┘
└─────────────────────┘        └──────────────────────────┘
```

---

## 1. Publicar o Worker (backend)

Pré-requisitos: conta na Cloudflare e [Node.js](https://nodejs.org). O Wrangler é a CLI da Cloudflare.

```bash
cd worker
npm install
npx wrangler login
```

Crie o KV e cole o `id` retornado no `wrangler.toml` (campo `kv_namespaces[0].id`, binding `KV`):

```bash
npx wrangler kv namespace create KV
```

Configure o envio de e‑mail de recuperação de senha com o **Resend**:

1. Crie uma conta em [resend.com](https://resend.com) e gere uma **API Key**.
2. Guarde a chave como *secret* (nunca no código):

```bash
npx wrangler secret put RESEND_API_KEY
```

3. (Opcional) Trave o cadastro com um código de acesso da equipe:

```bash
npx wrangler secret put SIGNUP_CODE
```

No `wrangler.toml`, ajuste:
- `ALLOWED_ORIGIN` → origem do site (ex.: `https://SEU_USUARIO.github.io`).
- `FROM_EMAIL` → remetente. Para testar rápido use `Blendibox <onboarding@resend.dev>` (o Resend só entrega para o e‑mail dono da conta nesse modo). Em produção, **verifique seu domínio** no Resend e use algo como `Blendibox <no-reply@seudominio.com>`.
- `APP_URL` → URL do site para montar o link de recuperação (ex.: `https://SEU_USUARIO.github.io/SEU_REPO/`).

Depois publique:

```bash
npx wrangler deploy
```

O deploy imprime a URL do Worker, algo como
`https://blendibox-comex-api.SEU_SUBDOMINIO.workers.dev`. **Guarde essa URL.**

### Testar o Worker

```bash
curl "https://blendibox-comex-api.SEU_SUBDOMINIO.workers.dev/api/comexstat?flow=import&ncm=42022220&from=2024-01&to=2024-12"
```

---

## 2. Publicar o site (GitHub Pages)

1. Edite **`docs/index.html`** e troque a URL do Worker:

   ```js
   window.BB_CONFIG = {
     workerUrl: "https://blendibox-comex-api.SEU_SUBDOMINIO.workers.dev"
   };
   ```

2. Suba o repositório para o GitHub:

   ```bash
   git init
   git add .
   git commit -m "Blendibox Sourcing: site + worker"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/SEU_REPO.git
   git push -u origin main
   ```

3. No GitHub: **Settings → Pages → Build and deployment**
   - *Source:* **Deploy from a branch**
   - *Branch:* **main** / pasta **`/docs`** → **Save**.

   Em ~1 minuto o site fica em `https://SEU_USUARIO.github.io/SEU_REPO/`.

4. Garanta que o `ALLOWED_ORIGIN` do Worker é exatamente a origem do site
   (`https://SEU_USUARIO.github.io`). Se mudar, rode `npx wrangler deploy` de novo.

---

## 3. Usar

- **Mercado ao vivo:** escolha a NCM (começa em `42022220` – bolsas têxteis), o fluxo e o período → **Consultar**. Mostra total importado, principais países, participação da China e **preço médio US$/kg** (referência de negociação).
- **Fornecedores:** cada pessoa cria sua **conta** (nome + e‑mail + senha) e faz login. Esqueceu a senha? Clique em **“Esqueci minha senha”** → chega um link por e‑mail (Resend) que abre a tela de redefinição. Os fornecedores ficam no KV, visíveis para todos os usuários logados.
- **Calculadora, Polos, Passo a passo, Glossário:** funcionam offline, sem backend.

### Endpoints do Worker

| Método | Rota | Para quê |
|---|---|---|
| GET | `/api/comexstat` | Dados do Comex Stat (público) |
| POST | `/api/auth/register` | Cadastro (nome, e‑mail, senha, código opcional) |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/forgot` | Envia e‑mail de recuperação (Resend) |
| POST | `/api/auth/reset` | Redefine a senha pelo token do e‑mail |
| GET/POST/DELETE | `/api/suppliers` | Fornecedores (exige login) |

---

## Estrutura

```
comercio_exterior/
├── docs/
│   └── index.html         # site estático (GitHub Pages)
├── worker/
│   ├── src/index.js        # Cloudflare Worker (proxy + KV)
│   ├── wrangler.toml       # config (KV id, ALLOWED_ORIGIN)
│   └── package.json
└── README.md
```

## Notas

- Alíquotas, MOQs e preços são **estimativas de referência**; confirme a NCM e os tributos com seu despachante/contador.
- Dados de mercado: **Comex Stat / MDIC** (oficiais, agregados — não identificam o importador).
- Autenticação: senha com hash **PBKDF2** (Web Crypto), sessão por **token Bearer** (30 dias) no KV. O site é público (GitHub Pages), então, se quiser limitar quem cria conta, defina o `SIGNUP_CODE`. Para e‑mail de produção, verifique seu domínio no Resend.
