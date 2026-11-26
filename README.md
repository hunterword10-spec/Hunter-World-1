# Hunter World — Online

Versão multiplayer do Hunter World, construída **sobre o jogo existente** (nenhum sistema, mapa, classe, monstro, item ou balanceamento foi removido). O arquivo original permanece intacto; o jogo atualizado está em `public/game.html`.

## 1. Como rodar

Requisitos: Node.js 22 ou superior (usa `node:sqlite`).

```bash
cd hunter-online
npm install          # instala apenas "ws"
node server/server.js
```

Atalhos incluídos: `./start.sh` (Linux/macOS) ou `start.bat` (Windows) instalam a dependência na primeira execução e sobem o servidor; `npm start` faz o mesmo.

O terminal mostra os endereços. No computador: `http://localhost:8080`. No celular Android, conecte no mesmo Wi-Fi e abra `http://IP-DO-PC:8080`.

Variáveis opcionais:

| Variável | Padrão | Função |
| --- | --- | --- |
| `PORT` | `8080` | porta HTTP/WebSocket |
| `DATA_DIR` | `server/data` | pasta do banco SQLite |
| `OWNER_KEY` | vazio | chave que transforma a conta em **criador** (acesso ADM total) |

Para criar a conta do criador:

```bash
OWNER_KEY=minha-chave-secreta node server/server.js
```

Na tela de conta, abra **Criar conta**, preencha usuário/senha e coloque a chave no campo “Chave do criador”. Só essa conta vê o **Painel ADM**.

## 2. O que está funcionando

**Contas e personagens** — cadastro/login com senha protegida por `scrypt`, sessão por token (30 dias), um personagem por conta, nome único, login automático e salvamento no servidor. Entrar na mesma conta em outro aparelho derruba a sessão anterior (evita personagem duplicado online).

**Mundo compartilhado** — WebSocket mantém presença por sala (cidade, dungeon, arena, raid). Outros jogadores aparecem no mapa com nome e nível acima da cabeça, andando e mudando de direção em tempo real (~8 envios/s, interpolação pelo servidor a 8 Hz).

**Chat** — global (persistido no banco), de guilda e de grupo, com histórico ao abrir a aba.

**Grupos** — criar, convidar por nome, aceitar/recusar, expulsar, sair, chat próprio. Limite de 5 jogadores. Convites aparecem como aviso e na aba **Grupo**.

**Dungeons online** — ao entrar numa dungeon em grupo, o servidor cria uma instância exclusiva do grupo. O anfitrião sincroniza posição/vida dos monstros e envia os abates; o servidor calcula XP/ouro e **deduplica por identificador de monstro**, então ninguém recebe recompensa duas vezes.

**Ranking global** — calculado no servidor a partir dos personagens reais (poder recalculado com limites plausíveis por nível). Os bots fictícios que apareciam no ranking foram removidos.

**Administração** — restrita ao papel `owner`: presente (moedas, cristais, mensagem), ajuste de nível, aviso global, expulsar, banir/desbanir, lista de jogadores online. Tudo validado no servidor e registrado em `audit`.

**Reconexão** — queda de internet: reconecta com espera progressiva (1s → 12s) e volta à mesma sala. Recarregar a página retoma o personagem automaticamente. Sem servidor, a tela de conta oferece **Jogar offline**, que mantém o jogo single-player como antes.

## 3. Autoridade do servidor

O cliente não decide mais nível, XP, moedas, cristais nem permissões:

- nível e XP são derivados do XP total guardado no servidor; cada salvamento aceita no máximo 5 níveis de progresso;
- moedas/cristais têm teto de ganho por salvamento; gastos são permitidos;
- atributos (ataque, defesa, vida, mana) são limitados por nível antes de compor o ranking;
- `role` (criador) vem do banco, nunca do cliente — `P.adm` é apenas reflexo visual;
- recompensas de dungeon passam pelo servidor com deduplicação;
- presentes administrativos só são aplicados se a conta autenticada for `owner`.

## 4. Estrutura

```
hunter-online/
├── public/game.html      jogo completo com a camada online
├── server/server.js      HTTP + WebSocket + SQLite (contas, salas, grupos, guildas, ADM)
├── server/data/          banco criado em tempo de execução
├── shots/                capturas dos testes
└── README.md
```

Endpoints HTTP: `/api/register`, `/api/login`, `/api/me`, `/api/logout`, `/api/character`, `/api/ranking`, `/api/stats`, `/api/health`.

## 5. Sobre Firebase

O pedido citava Firebase Authentication + Realtime Database/Firestore. Firebase exige um projeto e credenciais suas (`apiKey`, `projectId`, regras), que não existem neste ambiente. Para o jogo já funcionar de ponta a ponta, a mesma arquitetura foi implementada com servidor próprio: autenticação com hash `scrypt` + sessões, banco SQLite e WebSocket autoritativo.

Se quiser migrar para Firebase depois, os pontos de troca são isolados: `api()` e o `WebSocket` dentro do módulo `ONLINE` no `game.html`, e as funções de sessão/`handle()` no `server.js`. O protocolo de mensagens permanece o mesmo.

## 6. Testes executados

Duas sessões de navegador reais (Chromium) contra o servidor:

- cadastro, login, criação de personagem e conexão WebSocket;
- presença e movimento sincronizados entre dois jogadores;
- chat global e chat de grupo;
- convite de grupo, aceite e lista de membros;
- mesma instância de dungeon para o grupo, com anfitrião definido;
- ranking com jogadores reais e sem bots;
- salvamento no servidor e retomada após recarregar;
- reconexão automática;
- conta comum bloqueada em ações ADM; presente do criador aplicado;
- moedas infladas limitadas e nível derivado do XP real;
- recompensa de dungeon não duplicada;
- sessão única, personagem único por conta e nome único.
- smoke test de jogabilidade: andar, atacar, gastar mana, trocar de mapa, abrir as 8 abas do menu e entrar em dungeon solo (32 monstros gerados).

Resultado: 33/33 verificações automatizadas aprovadas, sem erros de JavaScript nas páginas.

## 7. Publicar na internet

Para jogar fora da rede local, hospede em um servidor com Node 22 (VPS, Render, Railway, Fly.io ou um computador persistente). Requisitos:

- comando de start `node server/server.js` e porta fornecida pela plataforma;
- disco persistente para `server/data` (senão contas somem ao reiniciar);
- HTTPS no proxy — o cliente detecta e usa `wss://` automaticamente.

## 8. Limites conhecidos

- O combate continua rodando no cliente (como no jogo original); em dungeon, o anfitrião é a referência para vida/abates dos monstros.
- Guildas têm limite de 20 membros no servidor; o painel do jogo mostra os membros reais.
- Sem HTTPS, navegadores móveis podem bloquear o microfone/fullscreen, mas o jogo funciona normalmente.
