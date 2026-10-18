# Soya Zhiban · Home Plant Care

**Keep household plant records, organize care problems such as yellow leaves and explore care suggestions.**

## Start here if you do not code

This is a small household plant-care app: keep a record of each plant and explore care suggestions when leaves or growth change. It does not diagnose a plant or prescribe pesticide doses.

**No one-click public demo has been verified in this review.** The full app needs someone to complete the computer setup below. You do not need to copy commands you do not understand. To try the idea first, copy this into an AI chat:

```text
Help me organize a fictional plant-care problem: an indoor pothos in bright indirect light has two yellow leaves. Ask about watering, light and soil before suggesting possible causes, low-risk observations and when to seek expert help. Do not diagnose or prescribe pesticides.
```

Expect questions and observation suggestions. This does not create plant records or install the full app. Your AI service may charge fees; use non-sensitive text.

If someone helps set up the app, first add a fictional plant manually, close the page and reopen it to check that the record remains. Photo recognition and weather are optional services requiring extra setup; relevant photos or location details may leave your device. Avoid faces, home addresses and work materials. Read the data notes before using them.

The commands and hosting sections below are for helpers and developers. Current access protection has known gaps: do not connect paid services and expose the app to the public as-is. The **Issues** tab is a public question area; remove private/work information before posting.



Keep local records of the plants you already own, organize them by placement, investigate symptoms and generate printable five-line care cards. Optional photo recognition and weather features require configured external services.

[中文](README.md) · [Deployment](DEPLOY.md) · [Maintenance and recovery](MAINTENANCE.md)

## Background, users and boundaries

For Chinese-speaking households caring for a few to dozens of plants, including beginners who want practical suggestions without accounts or daily check-ins. The application has no watering log, countdown or task calendar. It is not an encyclopedia, medical diagnosis, pesticide-dosage guide, family cloud-sharing service or universal plant identifier. Recognition is not live until the required provider is configured.

## Quick start

Install Node.js 18+ as documented by the project, then:

```bash
git clone https://github.com/soyoungzsy/zhiban.git
cd zhiban
MOCK_VISION=1 node server/server.js
```

Open `http://127.0.0.1:8438/?demo=1`. Expect the Chinese plant-care UI, a fictional example home and weekly focus. Detection uses explicitly labeled mock results, not real image recognition. These environment-variable commands use a POSIX shell; configure equivalent variables on other systems. If the port is occupied, use `MOCK_VISION=1 PORT=8440 node server/server.js` and open port 8440 rather than killing an unknown process.

To try it on a phone, use the computer's LAN address on the same Wi-Fi. This is personal LAN testing, not a public deployment. PWA installation/offline behavior depends on a secure browser context; an HTTP LAN address does not establish that behavior. Static-only hosting can support manual records/cards, but recognition and weather need the proxy. There is currently no public service provided by this repository.

## First successful task

Create one plant through the add button, select or enter a name, register its location and save. Refresh to confirm persistence. Read its care suggestions, or select symptoms to inspect likely directions and observation steps. Generate a five-line care card and copy/save it for printing. Batch-photo flows produce drafts for human correction and confirmation; they do not establish identification accuracy.

## Capabilities and limits

Suggestions combine species, city/season, placement and recent observations. Indoor and exposed outdoor placements are treated differently; names alone do not determine conditions. Weekly focus avoids stale evidence. Photo records distinguish file timestamps from confirmed capture times. Batch drafts can be corrected and merged before committing. Five-line cards enforce length constraints.

Real photo-environment extraction, photo-health analysis, cloud family sharing and model-based voice interpretation are not implemented as live features. Voice handling currently uses bounded rules. Species knowledge is a small built-in set, not a broad scientific database. Care advice remains a user judgment.

## Providers, cost and privacy

Manual/demo use needs no provider key or model call. Optional recognition forwards selected photos through your own server to Zhipu GLM; weather sends selected city/coordinates to QWeather. Configure the credentials described in `server/.env.example` only on your server; provider use and hosting may cost money, and their retention rules apply. Do not claim all data remains on-device once live features are enabled. Never commit `.env`, real photos or exports.

Plant records use browser localStorage and photos use IndexedDB. No account or cloud sync is included. Changing browser/profile/origin—including protocol, domain or port—changes the storage context. Export a complete backup from Settings and verify restoration before upgrading or moving devices. Uninstalling/clearing browser storage can remove local data.

## Public deployment security boundary

Read [DEPLOY.md](DEPLOY.md), but do not treat its prior deployment claims as this review's approval. The current server injects API_ACCESS_KEY into publicly readable HTML, so this value is not effective identity authentication for public paid APIs. Forwarded-IP limits assume a trusted proxy, and in-memory budgets do not persist across instances/restarts. Configure real access control and spending protection and revalidate before public paid use. Personal mock testing is the recommended starting point.

## Maintenance and validation

Preserve source and export data before updating. Reverting code/Service Worker does not necessarily restore compatible data. Use the backup/restore controls and [maintenance guide](MAINTENANCE.md). Missing recognition generally means the proxy/provider is unconfigured; inspect the labeled service status rather than assuming real recognition. For browser-script failures, use the supported Chrome path or adapt the test configuration.

The project documents `npm ci`, `npm test`, `npm run verify:v4` and `npm run verify:pwa`; runtime itself has no npm dependencies, while browser/test tooling does. Historical test counts in the Chinese README are prior claims, not results rerun by this documentation proposal. No new live-provider or mobile acceptance is claimed. See [CONTRIBUTING.md](CONTRIBUTING.md), existing REVIEW documents and [MIT license](LICENSE).
