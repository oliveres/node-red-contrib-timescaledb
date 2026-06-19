# Instalační instrukce pro node-red-contrib-timescaledb

## Příprava balíčku

### 1. Vytvoření npm balíčku lokálně

```bash
# V adresáři projektu
npm pack
```

Tím se vytvoří soubor `node-red-contrib-timescaledb-0.1.0.tgz`.

### 2. Přenos na vzdálený server

Přeneste `.tgz` soubor na váš Node-RED server pomocí SCP, FTP nebo jiné metody:

```bash
scp node-red-contrib-timescaledb-0.1.0.tgz user@server:/path/to/destination/
```

## Instalace na Node-RED serveru

### Metoda 1: Instalace z lokálního souboru

```bash
# Přihlaste se na server
ssh user@server

# Přejděte do Node-RED adresáře (obvykle ~/.node-red)
cd ~/.node-red

# Nainstalujte z .tgz souboru
npm install /path/to/node-red-contrib-timescaledb-0.1.0.tgz

# Restartujte Node-RED
node-red-restart
# nebo
systemctl restart nodered
# nebo
pm2 restart node-red
```

### Metoda 2: Instalace přes Node-RED UI

1. Zkopírujte `.tgz` soubor do přístupného adresáře na serveru
2. V Node-RED UI: Menu → Manage palette → Install
3. Místo názvu balíčku zadejte cestu k souboru: `file:///absolute/path/to/node-red-contrib-timescaledb-0.1.0.tgz`

### Metoda 3: Instalace z npm registry (pokud publikujete)

```bash
# Publikovat na npm (vyžaduje npm účet)
npm publish

# Pak na serveru
cd ~/.node-red
npm install node-red-contrib-timescaledb
```

### Metoda 4: Instalace z GitHub

```bash
cd ~/.node-red
npm install git+https://github.com/oliveres/node-red-contrib-timescaledb.git
```

## Konfigurace

### 1. Příprava TimescaleDB

Vytvořte databázi a tabulku podle `database-schema.sql`:

```bash
# Připojte se k PostgreSQL/TimescaleDB
psql -U postgres -h localhost

# Vytvořte databázi
CREATE DATABASE mydata;

# Připojte se k databázi
\c mydata

# Spusťte SQL schéma
\i /path/to/database-schema.sql
```

### 2. Konfigurace v Node-RED

1. Po restartu Node-RED najdete nové uzly v paletě:
   - **MQTT to TimescaleDB** (v kategorii "storage" nebo "output")
   - **Payload to TimescaleDB** (v kategorii "storage" nebo "output")

2. Přetáhněte uzel do flow

3. Dvojklikem otevřete konfiguraci:
   - Klikněte na tužku vedle "Server" pro vytvoření nového připojení
   - Vyplňte:
     - Host: `localhost` nebo IP adresa TimescaleDB
     - Port: `5432` (výchozí PostgreSQL port)
     - Database: `mydata` (nebo název vaší DB)
     - User: `postgres` (nebo váš uživatel)
     - Password: vaše heslo
     - SSL: podle potřeby

4. Nastavte další parametry podle potřeby:
   - Schema: `industrial` nebo `home`
   - Payload Type: `naked` nebo `JSON object`
   - Další parametry podle dokumentace

## Ověření instalace

1. Vytvořte jednoduchý test flow:
   ```
   [Inject node] → [Payload to TimescaleDB] → [Debug node]
   ```

2. V Inject node nastavte payload:
   ```json
   {
     "measurement": "temperature",
     "field": "value",
     "payload": 23.5
   }
   ```

3. Deploy flow a klikněte na Inject

4. Zkontrolujte databázi:
   ```sql
   SELECT * FROM measurements ORDER BY time DESC LIMIT 10;
   ```

## Řešení problémů

### Node se nezobrazuje v paletě
- Zkontrolujte logy Node-RED: `node-red-log` nebo `journalctl -u nodered`
- Ověřte instalaci: `cd ~/.node-red && npm list node-red-contrib-timescaledb`

### Chyba připojení k databázi
- Ověřte, že TimescaleDB běží: `systemctl status postgresql`
- Zkontrolujte firewall pravidla
- Ověřte pg_hba.conf pro povolené připojení

### Permission denied
- Ujistěte se, že Node-RED proces má práva k ~/.node-red/node_modules

## Další kroky

- Prostudujte [README.md](README.md) pro příklady použití
- Přečtěte [DOC_DETAILS.md](DOC_DETAILS.md) pro detailní dokumentaci
- Importujte ukázkový flow z `test/flow.json`