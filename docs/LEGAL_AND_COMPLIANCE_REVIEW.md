# Sidekick App – Legal, Privacy & Accessibility Review

Reviewed: October 12, 2026 · Operator: Sidekick App (student capstone project by Carl, Santo Tomas, Batangas) · Privacy contact: s2023101800@firstasia.edu.ph

> This is a technical compliance review written for a capstone project, not legal advice. Before a public commercial launch, have the documents checked by a Philippine lawyer or your school's legal/data-privacy office.

---

## 1. What was added or fixed

| Area | Change |
|---|---|
| Privacy Policy | New `mobile-app/privacy.html`: what is collected, why, where it is kept, who it is shared with (Google Gemini / Maps / Fonts, Reoon, ZeroBounce, email provider), retention periods, security, the full list of Data Privacy Act rights, NPC complaint route, 72-hour breach notice. |
| Terms and Conditions | New `mobile-app/terms.html` replaces the 3-paragraph text: 18+ only, planning-tool-only (no bookings), AI and estimate disclaimers, acceptable use (incl. no fake reviews), IP, liability limits that respect non-waivable consumer rights, Philippine governing law (RA 8792). |
| Cookie & Storage Notice | New `mobile-app/cookies.html`: no cookies or trackers; lists the device storage the app needs; discloses Google Maps/Fonts loading. |
| Consent at sign-up | Registration now needs two ticked boxes: "I confirm I am 18 or older" and "I agree to the Terms … and consent to processing … as described in the Privacy Policy". Both documents open inside the sign-up dialog. The server also refuses registration without the age confirmation. |
| Right to erasure | New **Settings → Delete my account** (password-confirmed). Deletes the account, trips, preferences, ratings and codes on the server in one transaction, signs out all sessions, and clears the user's data on the device. |
| Legal links | Welcome screen, login screen and Settings → "Legal & privacy" (with the privacy contact). |
| Admin notice | Admin sign-in now states it is for authorized administrators, sign-ins are logged, and user data must be handled under RA 10173. |
| AI transparency | Chat header: "AI replies can be wrong. Check important details." Opening message no longer claims Sidekick is "trained". |
| Google Maps attribution | "Places, photos and ratings from Google Maps" under dashboard lists, See-all list, Hotels & restaurants, and chat place cards. Photographer credit added to the dashboard destination photo (it was missing). |
| Security fixes | 6 API routes (`/api/preferences/:email`, `/api/trips/:email`, `/api/reminders/:email`, GET + POST/PUT) let **anyone read or change any user's data by email with no sign-in**. They now require sign-in and only allow your own email. Google Maps routes and the AI price-estimate route now require sign-in, so outsiders cannot spend your API credits. Login is rate-limited and no longer reveals whether an email is registered. |
| Leaked key | A real Google Maps API key was in `mobile-app/js/config.local.example.js` (committed to GitHub). Replaced with a placeholder. **It is still in the git history – see risk H1.** |
| Accessibility | See section 4. |

---

## 2. Cookie consent and tracking – conclusion

- **No cookie banner is needed.** The app and admin site set **no cookies** and use **no analytics, advertising or tracking tools** (checked: no Google Analytics/Tag Manager, Firebase, Facebook Pixel, Hotjar, Clarity, etc.).
- The app saves data only in the device's local/session storage, and all of it is needed for the app to work. The Data Privacy Act requires you to *tell* users about this (done in the Cookie & Storage Notice), not to ask permission for strictly necessary storage.
- If you ever add analytics, crash-reporting SDKs or ads, you must **ask for consent first** and update the Cookie & Storage Notice and Privacy Policy.

## 3. Third-party embeds – are they safe?

| Third party | Data it receives | Assessment |
|---|---|---|
| Google Maps JavaScript API (maps, markers) | User's IP, map views | Safe and disclosed. Keep the key restricted (H1). |
| Google Places photos | Loaded through **your** backend (`/api/maps/photo`), so Google does not see the user's IP for photos | Good design. Photographer credits are shown. |
| Google Fonts (`fonts.googleapis.com`) | User's IP | Low risk, disclosed. Optional: self-host the fonts (also makes the APK work offline). |
| Google Gemini API (paid tier) | Chat messages, trip details, preferences | Disclosed. Paid tier: Google says it does not use prompts to improve products. Users are told not to enter sensitive info. |
| Reoon / ZeroBounce | Email address at sign-up | Disclosed. Cross-border transfer. |
| Email provider (SMTP) | Email address + code | Disclosed. See M3. |
| "Open in Google Maps" links | Opens Google's site/app | Normal external link; Google's terms apply there. |

No iframes from other sites, no social-media widgets, no ad networks.

## 4. Accessibility (WCAG 2.1 AA)

Fixed:
- **Color contrast:** primary buttons were white text on light teal (as low as **1.8:1**); now **5.0–5.8:1**. Links, muted text, selected chips, nav highlight, danger links, tags and icon buttons were all raised to at least 4.5:1 (text) / 3:1 (icons). Every new color was measured. Fixes live in one stylesheet, `mobile-app/css/a11y.css`, loaded last on every page.
- **Clear button labels:** 6 icon-only back buttons, the chat *send* and *clear* buttons now have spoken names; the bottom navigation keeps its labels for screen readers on narrow phones (they were removed entirely below 420 px).
- **Form labels:** chat box, dashboard search and 4 Alerts fields now have labels. An automated scan of every app page now finds **0** unlabeled fields or unnamed buttons.
- **Keyboard:** visible focus ring on links, buttons, checkboxes, selects and summaries; dialogs close with Esc; OTP boxes support arrows/backspace/paste.
- **Alt text:** content images have meaningful alt text; decorative logos/thumbnails next to visible names correctly use empty alt.
- **Motion:** animations are switched off when the phone's "reduce motion" setting is on.

Still recommended: a manual pass with Android **TalkBack** on the built APK, and checking text at 200% font size.

## 5. Fake reviews and unsupported claims

- **No fake reviews.** The database has 2 app reviews, each tied to a real registered account; no code or SQL script inserts sample reviews. The Terms now forbid false reviews.
- **Claims reviewed:** "Your intelligent guide to exploring the Philippines" is ordinary promotional wording. Prices, travel times and "within budget" labels are presented as **estimates** in the app and Terms. Removed "I am trained…" from the chat greeting. The app makes no claims about user numbers, awards, rankings or guarantees.

## 6. Images and copyright

| Asset | Status |
|---|---|
| `assets/sidekick-logo-*.png` (app + admin) | **Confirm you created it** or have a license. If it was AI-generated, keep a record of the tool and its terms. |
| `assets/sidekick-robot.png.jpg` | **Deleted.** The robot image (also formerly the Android launcher icon) was removed; the app icon is now the compass logo. |
| Google place photos | Shown under Google Maps Platform terms with author attribution, via Google's API (not copied). Do not download or re-host them. |
| Google logo on the itinerary autocomplete | Required attribution, used as Google provides it. |
| Fonts (DM Sans / Manrope via Google Fonts) | Open Font License; free to use. |
| Icons (inline SVG) | Hand-written simple shapes; confirm if any came from an icon library and keep its license (e.g. MIT/ISC for Feather/Lucide). |

## 7. Philippine laws and rules that apply

| Law / rule | Why it applies | Status |
|---|---|---|
| **Data Privacy Act of 2012 (RA 10173)**, IRR, NPC circulars | You collect and process personal data | Policy, consent, rights handling, deletion, DPO contact, breach-notice commitment – done. NPC registration: see M1. |
| **Electronic Commerce Act (RA 8792)** | Makes click-to-agree Terms and electronic consent legally valid | Terms reference it. |
| **Civil Code of the Philippines** | Minors cannot fully consent to contracts | App limited to 18+. |
| **Cybercrime Prevention Act (RA 10175)** | Illegal access, data interference | Protects your system. Your own security duties are covered under the DPA. |
| **Intellectual Property Code (RA 8293)** | Logos, images, app content | See section 6. |
| **Consumer Act (RA 7394)** | No misleading claims or advertising | Estimates labeled; no false claims. |
| **Internet Transactions Act of 2023 (RA 11967)** | Applies to online selling/transactions | **Not applicable now** (Sidekick sells nothing). Applies if you add bookings or payments. |
| **Magna Carta for Persons with Disability (RA 7277, as amended) / BP 344** | Accessibility | Not strictly mandated for private apps; WCAG 2.1 AA followed as good practice. |
| Google Maps Platform Terms, Gemini API Terms, Google Play Developer Policy | Contracts you accepted | Attribution added; 18+ rule; see H1, M2, M5. |
| GDPR (EU) / CCPA (California) | Only if you target users there | Not applicable to a Philippine capstone. |

---

## 8. Risk register

### High – fix before deploying
- **H1 – Google Maps API key exposed in GitHub history.** Key `AIzaSyD6Ip…` was committed in `config.local.example.js` (commits 64b8323 … 78849e5) to `github.com/Cil816/Capstone_Sidekick`. **Action:** in Google Cloud Console → Credentials, add **application restrictions** (HTTP referrers for your web domain; Android app `com.sidekick.app` + SHA-1 for the APK) and **API restrictions** (only the Maps JavaScript API). If the repo is public, also **regenerate the key**. Set a budget alert.
- **H2 – Use HTTPS in production.** Passwords and tokens travel to the backend. The app already refuses a non-HTTPS server in production builds; make sure the deployed backend and admin site use HTTPS.

### Medium
- **M1 – NPC registration.** You must register your data processing system with the NPC once you process personal data of **1,000 or more people** (or sensitive personal information). A capstone demo is below this; re-check before a public release.
- **M2 – Gemini API terms.** Keep the **paid tier** (the Privacy Policy says Google does not use prompts to improve its products – that is only true on the paid tier) and keep the 18+ rule. Follow Google's Generative AI Prohibited Use Policy.
- **M3 – School email used for sending codes and as privacy contact.** The FAITH student account may not allow app/business use, and it may be closed after graduation – then nobody receives privacy requests. Before a public release, create a dedicated address (e.g. a new Gmail for Sidekick) and update `SMTP_*` in `.env`, the Privacy Policy, Terms, Cookie Notice and Settings.
- **M4 – Open CORS and no security headers.** `app.use(cors())` accepts any website. When deploying, limit CORS to your admin-site domain (the APK does not need it) and add security headers (e.g. the `helmet` package).
- **M5 – Google Play release.** Fill in the **Data safety** form to match the Privacy Policy, give the Privacy Policy URL (the backend already serves it at `https://<your-server>/privacy.html`), and add the **account-deletion web link** Play requires (the same page explains how to request deletion; in-app deletion is done).
- **M6 – Public photo endpoint.** `/api/maps/photo` must stay public for images to load, so outsiders could use your Places photo quota. Rate-limit it or add a Google Cloud quota cap.

### Low
- **L1 – Google Fonts** sends users' IPs to Google (disclosed). Optional: self-host.
- **L2 – Logo and robot image ownership** – confirm (section 6).
- **L3 – Cached Google photo names** in chat history and itineraries can expire; the app already falls back to a placeholder. Google prefers not caching photo names long-term.
- **L4 – Sessions are stored in server memory:** restarting the backend signs everyone out. That is safe, just inconvenient.
- **L5 – Admin access:** use a strong `ADMIN_PASSWORD`, never share it, and check the admin audit log occasionally.
- **L6 – Breach response:** if user data leaks, notify the NPC and affected users within **72 hours** (NPC Circular 16-03).

---

## 9. Your to-do list
1. Restrict (and if the repo is public, regenerate) the Google Maps key – **H1**.
2. Restart the backend so the new security checks and endpoints are active (everyone will need to sign in again).
3. Confirm the compass logo is yours (the robot image has been deleted).
4. Before a public/Play release: dedicated contact email (M3), HTTPS (H2), CORS + headers (M4), Play Data safety + deletion link (M5), and a lawyer's review of the documents.
