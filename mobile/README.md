# PredictPool mobile app (iOS & Android)

A React Native app built with **Expo SDK 58** and **Expo Router**. It is the participant app for the PredictPool backend in the parent folder, and it uses the same API, ledger and rules. The operations portal stays on the web (`/ops.html`), because it is an admin tool that requires administrator sign-in with MFA.

Funds are **simulated**, and every screen says so.

## What's in it
| Tab or screen | What the user can do |
|---|---|
| **Sign in / Create account** | Email and password. The session token is stored in the iOS Keychain or Android Keystore (`expo-secure-store`, *this-device-only*). |
| **Verify** (modal) | Identity and eligibility check. Rejections show the reasons. |
| **Pools** | Open and closed pools with deposit, fee, refundable amount and funded prize. Pull to refresh. |
| **Pool detail** | Server-time countdown, per-selection bonus **estimate** with maximum, full disclosure ("you can lose the fee"), and collapsible settlement rules with the terms hash. |
| **Confirm sheet** | Restates what is locked, what is lost if wrong, and the estimated bonus. The user must accept the rule version. One idempotency key per confirmation, so a retry on a flaky connection cannot enter twice. |
| **Receipt** | Selection, amounts, server timestamp, rule version, terms hash, ledger transaction. |
| **My entries** | Status of each entry, locked deposit or net credit; tap to track the pool or open the statement. |
| **Statement** | Itemised settlement: deposit, fee, returned deposit, gross bonus, withholding, net credit. |
| **Dispute** (sheet) | Available while the result is under review. Settlement is held while a dispute is open. |
| **Wallet** | Available, locked and pending balances; simulated deposit (credited only after the provider's signed callback); withdrawal with live status polling; ledger-backed history. |
| **Account** | Verification status with masked document number, daily deposit limit, self-exclusion (confirmed in a sheet), build info, sign out. |

All money handling is in integer minor units (`src/lib/money.ts`). Amounts typed by the user are parsed without floating point.

## Design: "Floodlit"
The look is a stadium at night. Each screen opens on a dark indigo band with the title and the screen's key figure in condensed scoreboard type. Content sits below on a cool pitch-line grey.

| Token | Value | Used for |
|---|---|---|
| Night | `#1B1A4A` | hero bands, primary ink |
| Floodlight amber | `#FFC23D` | your selection and the one action that matters on a screen |
| Turf mint | `#22B07D` | money that comes back to you |
| Signal red | `#E5484D` | the fee, which is the only money you can lose |
| Pitch-line grey | `#EEF0F7` | page background |

- **Type:** Barlow Condensed for headings, team names and figures; Barlow for body text. One family in two widths, loaded with `expo-font` (only the 7 weights used).
- **Two signature devices:**
  - the **split bar** draws every deposit as a large mint share that comes back and a thin red sliver that is the fee;
  - **tickets** for pools, entries and receipts, with a perforated tear line and notches.
- Tokens live in `src/lib/theme.ts` and components in `src/components/ui.tsx`.

## Run it
1. **Start the backend** (repo root):
   ```bash
   npm install && npm run seed && npm start      # API on :3000
   ```
2. **Install and start the app** (this folder):
   ```bash
   npm install
   npx expo start
   ```
   - Press **w** for the web build, or open it on a device or simulator (next step).
   - The app finds the API automatically in development: it uses the same LAN IP that Metro is serving on, port 3000.
   - To point it elsewhere: `EXPO_PUBLIC_API_URL=https://your-api npx expo start`.
3. **Run on a phone or simulator.** SDK 58 apps run in a development build, because Expo Go may not support SDK 58 yet.
   ```bash
   npx expo run:ios          # needs Xcode
   npx expo run:android      # needs Android Studio / SDK
   # or build in the cloud, no local toolchain:
   npx eas-cli@latest build --profile development --platform all
   ```
   - The phone must be able to reach the API on your machine. Use the same Wi-Fi, and allow port 3000 through the firewall.
   - The Android emulator falls back to `10.0.2.2:3000`.

**Demo login:** create an account in the app. Verify with any date of birth that makes you 18+, a document number of 6+ characters, and jurisdiction **DEMO**. Then deposit, pick a winner and confirm.

To complete a pool, settle it in the ops portal at `http://localhost:3000/ops.html`: sign in as `ops@demo.test` / `demo-password` and press "Demo authenticator" for the code.

## Checks
```bash
npm run typecheck     # tsc, strict
npm run lint          # expo lint
npm run export:native # bundles iOS + Android JS (Hermes bytecode) — catches resolution errors without Xcode/Android Studio
npm run export:web && npx serve dist-web -s -l 8081   # then: npm run e2e:web (needs Playwright)
```
`scripts/web-journey.js` drives the whole journey at iPhone 14 size against the web build: register, verify, deposit, enter, ops settles, statement, withdraw. It fails on any JavaScript error. The screenshots in `../docs/screenshots/mobile-journey.png` come from this script.

## Release builds
`eas.json` has three profiles: `development` (dev client), `preview` (internal; Android APK) and `production` (store builds, auto-incremented). Before any store submission:
- Replace the placeholder `bundleIdentifier` and `package` (`com.example.predictpool`) and the API URLs in `eas.json`. Production must use **HTTPS**.
- Real-money gaming apps are subject to App Store and Google Play rules on gambling and contests, which can require licences per region and geo-restriction. This is one of the open decisions in `docs/01-PRD.md`. While funds are simulated, the store listing must not imply that real prizes are available.
- Add push notifications for receipts and settlements. The backend already emits `notify.entry_receipt` and `notify.pool_settled` outbox events. Adding them needs `expo-notifications`, a device-token endpoint, and a notification adapter in the worker.

## Structure
```
src/app/                 routes (Expo Router): sign-in, (tabs)/{index,entries,wallet,account}, pool/[id], receipt/[id], statement/[id], verify
src/components/ui.tsx    Screen (floodlit band), Ticket, SplitBar, Button, Pill, KV, Notice, Field, Chips, Checkbox, Sheet
src/components/faceoff.tsx  'Home vs Away' / tournament field in scoreboard type
src/lib/fonts.ts         Barlow + Barlow Condensed loading
src/components/icons.tsx tab icons (react-native-svg)
src/lib/api.ts           typed API client, base-URL resolution, idempotency keys
src/lib/session.tsx      auth/session context; Stack.Protected gates signed-in routes
src/lib/storage.ts       Keychain/Keystore token storage (sessionStorage on web)
src/lib/money.ts         minor-unit formatting and parsing
```
