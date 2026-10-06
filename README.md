# Photo Backup Agent

Servizio Docker self-hosted che fa il backup **unidirezionale** della libreria fotografica di un HDD (es. 16 TB collegato a Umbrel) verso **Google Photos**, usando rclone.

```text
HDD /Photos ──(scan + watcher)──▶ stabilità + SHA-256 ──▶ queue SQLite ──▶ rclone copyto ──▶ Google Photos
```

- **Solo locale → cloud.** Usa esclusivamente `rclone copyto`; mai `sync`, `move` o `delete`. La libreria è montata `:ro`: il container non può modificare né cancellare foto. Nulla viene mai cancellato in cloud.
- **Queue persistente** in SQLite: sopravvive ai restart; un upload interrotto (crash, `kill -9`) torna `pending` all'avvio.
- **Deduplicazione** via SHA-256 (calcolato in streaming): lo stesso contenuto non viene caricato due volte, anche se il file viene rinominato, spostato o copiato in un'altra cartella.
- **File in copia**: un file viene processato solo quando dimensione e mtime restano invariati per `STABILITY_WINDOW_SECONDS`.
- **Retry con exponential backoff** (30s → 60s → 120s → 240s …) per errori di rete, 429 e 5xx; `MAX_RETRIES` configurabile; un file fallito non blocca la coda.
- **Finestra oraria** di upload + pulsante **Sync now**; **limite di banda** con `--bwlimit` nativo di rclone.
- **Dashboard** web e **REST API**.

## Avvio rapido

```bash
git clone … photo-backup && cd photo-backup
cp .env.example .env              # imposta almeno PHOTO_ROOT
mkdir -p database config/rclone logs
sudo chown -R 1000:1000 database config logs   # = PUID:PGID
docker compose build
```

Configura Google Photos (sezione successiva), poi:

```bash
docker compose up -d
docker compose logs -f
```

Dashboard: `http://<ip-umbrel>:8765`.

> Su Umbrel trova il percorso del disco con `df -h` o `lsblk` e mettilo in `PHOTO_ROOT`. Il container gira come `PUID:PGID` (default `1000:1000`, l'utente `umbrel`): deve poter leggere la libreria.

## Configurare rclone / Google Photos (OAuth)

Nessuna credenziale è nell'immagine: token e configurazione stanno in `./config/rclone/rclone.conf` (volume `/config`). rclone aggiorna da solo il token in quel file, per questo il volume è scrivibile.

L'OAuth richiede un browser, che Umbrel non ha: si usa la modalità "headless" di rclone.

1. **Sul tuo PC** (con browser) installa rclone ed esegui:
   ```bash
   rclone authorize "google photos"
   ```
   Fai login con l'account Google di destinazione e copia il JSON del token stampato a terminale.

2. **Su Umbrel**, avvia il wizard dentro il container:
   ```bash
   docker compose run --rm photo-backup rclone config
   ```
   - `n` (new remote) → nome: `gphotos` (deve coincidere con `RCLONE_REMOTE`)
   - storage: `google photos`
   - `client_id` / `client_secret`: vuoti oppure i tuoi (consigliato, vedi sotto)
   - `read_only`: **false** (serve per caricare)
   - "Use web browser to automatically authenticate?" → **n**
   - incolla il token ottenuto al passo 1
   - conferma e esci (`q`).

3. Verifica:
   ```bash
   docker compose run --rm photo-backup rclone lsd gphotos:
   ```
   e riavvia: `docker compose restart`. Nella dashboard l'avviso "rclone config not found" sparisce.

**Client ID proprio (consigliato).** Il client ID condiviso di rclone ha quote basse e condivise tra tutti gli utenti. Per una libreria grande crea un progetto su Google Cloud Console, abilita la *Photos Library API*, crea credenziali OAuth "Desktop app" e usale in `rclone config` (e anche in `rclone authorize "google photos" <client_id> <client_secret>`).

**Limiti di Google Photos da conoscere**
- Le API di Google Photos hanno quote giornaliere sugli upload: con molti file il servizio riceverà `429`; la coda va in pausa automaticamente e riprende con backoff.
- Google può ricomprimere i file a seconda del piano ("Storage saver" vs "Original quality"); il backup in Google Photos non è una copia bit-a-bit dell'originale.
- Dal 2025 le API permettono a rclone di vedere solo i media caricati da rclone stesso: è il motivo per cui la deduplica è fatta localmente (SQLite) e non interrogando Google.

## Come funziona

### Scanner, watcher e file in copia
- All'avvio fa una **scansione completa** di `/photos`, poi resta in ascolto con un **watcher** (chokidar/inotify). Ogni `RESCAN_INTERVAL_MINUTES` ripete la scansione come rete di sicurezza.
- Whitelist: `jpg jpeg heic png mp4 mov`. I RAW (`arw cr2 cr3 nef raf orf rw2 dng`) si abilitano con `INCLUDE_RAW=true`. Altre estensioni con `EXTRA_EXTENSIONS`.
- Ignorati: file/cartelle nascosti (`.*`), `@eaDir`, `#recycle`, `$RECYCLE.BIN`, `lost+found`, ecc.
- **Stabilità**: un file nuovo/modificato viene messo in osservazione; viene hashato solo quando size e mtime restano invariati per `STABILITY_WINDOW_SECONDS`. I file che nessuno tocca da più della finestra (mtime **e** ctime vecchi) passano subito: così la prima scansione di una libreria esistente non attende file per file, e un `cp -p` in corso (che preserva mtime) viene comunque riconosciuto grazie al ctime.
- Alle scansioni successive i file già noti con stessa size/mtime **non vengono ri-hashati**.
- Se la root è vuota (disco non montato) la scansione si ferma con un errore invece di considerare tutto "cancellato".

### Queue e stati

Tabella `files`: `path, filename, size, mtime, sha256, mime_type, status, retry_count, error, created_at, uploaded_at` (+ `ignored_reason, duplicate_of, remote_path, next_attempt_at, updated_at`).

| status      | significato |
|-------------|-------------|
| `pending`   | da caricare (eventualmente in attesa di backoff: `next_attempt_at`) |
| `uploading` | upload in corso; al riavvio torna `pending` |
| `uploaded`  | caricato |
| `failed`    | errore definitivo o retry esauriti → `POST /api/retry-failed` |
| `ignored`   | `duplicate` (contenuto già caricato/in coda), `deleted` (rimosso prima dell'upload), `missing` (sparito al momento dell'upload) |

### Deduplicazione
- La tabella `uploaded_hashes` è un registro permanente degli SHA-256 caricati: se lo stesso contenuto riappare sotto qualsiasi path (rinomina, spostamento, copia) viene marcato `ignored/duplicate`.
- Se due copie identiche sono entrambe in coda se ne carica una sola. Se quella "titolare" viene cancellata prima dell'upload, la coda promuove automaticamente un duplicato.
- Se un file già caricato viene sovrascritto con contenuto diverso, il nuovo contenuto viene caricato (il vecchio resta in cloud).

### Retry ed errori
| tipo errore rclone | comportamento |
|---|---|
| rete (DNS, timeout, reset…), 5xx, sconosciuto | retry con backoff `RETRY_BASE_SECONDS · 2^(n-1)` (30s, 60s, 120s, 240s…, max `RETRY_MAX_SECONDS`), poi `failed` dopo `MAX_RETRIES` |
| 429 / quota | come sopra **e** pausa dell'intera coda per lo stesso intervallo |
| config/auth (remote mancante, token revocato, rclone assente) | il file torna `pending` **senza consumare retry**; coda in pausa per `CONFIG_ERROR_PAUSE_SECONDS`; stato `degraded` |
| 400 / media non valido | `failed` subito |

I file in backoff non bloccano la coda: nel frattempo vengono caricati gli altri.

### Finestra oraria e Sync now
`SCHEDULE_START=02:00` / `SCHEDULE_END=07:00` (ora locale, `TZ`). Fuori finestra i file vengono comunque scansionati e messi in coda, ma non caricati. Le finestre a cavallo della mezzanotte (`22:00`→`06:00`) sono supportate; vuoto = sempre.

**Sync now** (dashboard o `POST /api/sync`): rescansiona e carica subito ignorando la finestra (e annullando un'eventuale pausa) finché la coda non è vuota, poi torna al comportamento schedulato.

### Banda
`MAX_UPLOAD_MBPS` (megabit/s) viene convertito nel `--bwlimit` nativo di rclone (KiB/s) e ripartito tra gli upload concorrenti (`UPLOAD_CONCURRENCY`). Esempio: 20 Mbit/s → `--bwlimit 2441k`.

### Album
- `RCLONE_DEST_PATH=upload` (default): libreria senza album.
- `RCLONE_DEST_PATH=album/Backup HDD`: tutto in un album.
- `GPHOTOS_ALBUM_MODE=folder`: album con il nome della cartella relativa (`2023/Vacanze/x.jpg` → album `2023/Vacanze`).

## API

| metodo | path | descrizione |
|---|---|---|
| GET  | `/health` | liveness (DB raggiungibile), usato dall'healthcheck Docker |
| GET  | `/api/status` | stato sintetico |
| GET  | `/api/stats` | contatori e byte per stato, file locali, configurazione |
| GET  | `/api/queue?status=&limit=&offset=` | senza `status`: coda (uploading + pending); altrimenti filtra per stato |
| POST | `/api/sync` | Sync now |
| POST | `/api/retry-failed` | rimette in coda i `failed` azzerando i tentativi |

```json
GET /api/status
{
  "status": "healthy",
  "queueSize": 1532,
  "failed": 2,
  "lastUpload": "2026-10-06T03:12:44.120Z",
  "currentUpload": { "id": 812, "path": "2024/IMG_0001.HEIC", "size": 2456123, "startedAt": "…" },
  "manualSync": false,
  "schedule": { "window": "02:00-07:00", "open": true, "nextOpenAt": null },
  "paused": null,
  "issues": [],
  …
}
```

`status` è `degraded` quando c'è un problema da risolvere (rclone non configurato, errore di autenticazione, root delle foto vuota/illeggibile): i dettagli sono in `issues`.

> L'API non ha autenticazione: esponila solo sulla rete locale (o dietro un reverse proxy con auth).

## Configurazione

Tutte le variabili sono in [`.env.example`](.env.example). Le principali:

| variabile | default | |
|---|---|---|
| `PHOTO_ROOT` | – | cartella host della libreria (montata `:ro`) |
| `SCHEDULE_START` / `SCHEDULE_END` | vuoto (sempre) | finestra upload `HH:MM` |
| `MAX_UPLOAD_MBPS` | `0` (illimitato) | limite banda in Mbit/s |
| `MAX_RETRIES` | `8` | retry prima di `failed` |
| `RETRY_BASE_SECONDS` | `30` | base del backoff |
| `STABILITY_WINDOW_SECONDS` | `30` | finestra di stabilità per file in copia |
| `INCLUDE_RAW` | `false` | abilita i RAW |
| `RCLONE_REMOTE` | `gphotos` | nome del remote in `rclone.conf` |
| `RCLONE_DEST_PATH` | `upload` | destinazione nel remote |
| `GPHOTOS_ALBUM_MODE` | `none` | `none` / `folder` |
| `UPLOAD_CONCURRENCY` | `1` | upload paralleli |
| `HASH_CONCURRENCY` | `2` | hashing paralleli (I/O su HDD) |
| `WATCH_POLLING` | `false` | polling invece di inotify |
| `RESCAN_INTERVAL_MINUTES` | `360` | rescan periodico (`0` = solo all'avvio) |

## Persistenza e container

| volume | contenuto |
|---|---|
| `/photos` (`:ro`) | libreria |
| `/database` | `photo-backup.db` (SQLite WAL) |
| `/config` | `rclone/rclone.conf` (token OAuth) |
| `/logs` | `agent.log` (ruotato a 50 MB all'avvio) |

- Utente non-root (`PUID:PGID`), healthcheck su `/health`, `init: true`.
- **Graceful shutdown** su `SIGTERM`: stop watcher, abort dell'upload rclone in corso (che torna `pending` senza consumare tentativi), chiusura di SQLite. `stop_grace_period: 30s`.

### Note per librerie grandi
- La **prima scansione** calcola lo SHA-256 di ogni file: su un HDD da 16 TB può richiedere molte ore (≈ velocità di lettura sequenziale del disco). Gli upload partono in parallelo man mano che i file vengono hashati. Le scansioni successive sono veloci (solo `stat`).
- inotify ha un limite di cartelle osservabili: se nei log compare `ENOSPC`, aumentalo sull'host
  `echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/99-inotify.conf && sudo sysctl --system`
  oppure usa `WATCH_POLLING=true` (o affidati al rescan periodico con `WATCH_ENABLED=false`).
- Backup del DB: basta copiare `./database` a container fermo. Se il DB viene perso, i file verrebbero ricaricati (Google Photos di solito scarta i duplicati identici, ma non è garantito).

## Sviluppo

```bash
npm install
npm test          # vitest: nessun upload reale, rclone è mockato
npm run build
PHOTOS_DIR=./sample DATABASE_PATH=./database/dev.db LOG_DIR=./logs RCLONE_CONFIG=./config/rclone/rclone.conf npm start
```

Struttura:

```text
src/
  config.ts             env → Config
  db/                   schema SQLite + repository (queue, dedup, stats)
  scanner/              filter, scanner, watcher, ingestor (stabilità + SHA-256)
  upload/               PhotoUploader → RcloneGooglePhotosUploader, classificazione errori
  queue/                worker (retry, backoff, pause), finestra oraria
  api/                  Fastify: REST + dashboard
  app.ts / index.ts     wiring, avvio, graceful shutdown
public/index.html       dashboard
test/                   scanner, file in copia, dedup, queue/recovery, retry, scheduler, watcher, rclone (mock), API
```

L'upload passa dall'interfaccia `PhotoUploader` (`upload(file): Promise<UploadResult>`): per passare in futuro alle API Google Photos dirette basta una nuova implementazione.
