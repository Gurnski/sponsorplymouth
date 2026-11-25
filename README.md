# Sponsor University of Plymouth

The site behind https://sponsorplymouth.co.uk. A group of University of Plymouth students are trekking to Everest Base Camp in summer 2027 for Amnesty International, and this is where their smaller fundraisers live.

There are three kinds of fundraiser:

- A dare board (the site calls it a Group Dare). People suggest dares for the whole group or for one walker. Group dares are ranked by free votes, and each walker's dares are ranked by donations to that walker's JustGiving page. The top dares are the ones that get done.
- An event, with a date, a place and a donate button.
- A challenge, which is the same as an event but labelled for sponsored things.

The site never handles money. Every donate button opens JustGiving. It runs on Cloudflare Workers with a D1 database, and the free tier should be plenty.

## What visitors see

- `/` has the Everest total, the featured fundraiser and the other live ones.
- `/f/<slug>` is one fundraiser: the dare board, or the event page.
- `/fundraisers` lists everything, finished ones included.
- `/about` and `/our-challenge` are two pages of text that leaders can edit.

Links from before there were several fundraisers still work. `/?dare=DARE-K7QM` and `/#emma` are sent on to the Dartmoor board.

## How the totals work

A dare board's total is counted for you: confirmed donations on dares that are still on the list. An event or challenge shows whatever total a leader types in.

The Everest total is read from JustGiving. It adds up the amount raised and the target on each page in the list under Site in the admin page. The figures are kept in the database and refreshed at most every 15 minutes, so a busy day doesn't mean thousands of calls to JustGiving. If JustGiving is down the last figures stay up, and if there have never been any the numbers are left out.

This needs a JustGiving AppID in `JUSTGIVING_APP_ID`. JustGiving says the platform behind this API ends on 30 June 2027 and recommends its Blackbaud SKY API instead, so the reading code in `src/worker.js` (`fetchJustGivingPage`) will need replacing before then.

## How dare donations get counted

The site can't see who donated for which dare, so each dare has a code like `DARE-K7QM`.

1. The donor copies the code, donates on JustGiving and pastes the code into their donation message.
2. They come back and log the amount. It shows as "being checked" and doesn't change the ranking.
3. A leader finds the donation on the JustGiving page and presses Confirm. Now it counts.

If someone donates with a code but never logs it, add it yourself under "Add a donation yourself" on that fundraiser's admin page. Watch for the reverse too: a donor who logs a donation you've already added by hand will show up for checking, and pressing "Can't find it" stops it counting twice.

Group dares take no money, because a donation to a shared page wouldn't count towards any walker's target.

## The admin page

`/admin` has four parts:

- To do: every dare waiting to be read and every donation waiting to be checked, across all fundraisers.
- Fundraisers: create and edit them, choose which one is featured on the homepage, and change their order. A dare board also has its walkers, its closing time and how many dares win.
- Site: the homepage intro, the About and Our Challenge text, and the JustGiving pages that make up the Everest total.
- Logins: leader keys. Only the owner sees this.

A fundraiser is a draft, live or finished. Drafts are invisible to the public, but a signed-in leader can preview one from the admin page. Finished fundraisers stay listed and stop taking dares and donations.

Photos are links. Host the image somewhere yourself and paste its `https://` address. A fundraiser without a photo gets contour art in its type's colour.

### Logins

`ADMIN_PASSWORD` is the owner's login and can do everything.

For anyone else, sign in as the owner, open Logins and create a key with their name on it. The key is shown once. Send it to them privately and have them save it in a password manager, because only a hash of it is stored and nobody can look it up later. A leader key does everything the owner can except create or revoke keys. Revoking a key signs that person out for good.

Approvals and confirmations record the name on the key that made them.

Ten wrong passwords or keys from one connection locks sign-in from that connection for 15 minutes.

## Try it on your computer

You need Node 22.13 or newer. The API tests use the SQLite that comes with Node.

```
npm install
cp .dev.vars.example .dev.vars    # then edit the password
npm run db:local
npm run db:demo                   # optional made-up fundraisers and dares
npm run dev
```

The site is at http://localhost:8787 and the admin page is at http://localhost:8787/admin.

Leave `JUSTGIVING_APP_ID` blank in `.dev.vars` and the Everest numbers are left out. Fill it in and your local copy reads the real pages.

`npm test` runs the unit tests and the API tests. The API tests run the real migrations against an in-memory SQLite database, so they need nothing running.

`npm run e2e` checks a running `npm run dev`. It expects a fresh copy of the demo data and leaves test records behind, so only use it locally. To start again from scratch, delete `.wrangler/state` and run the two `db:` commands.

## Put it live

You need a free Cloudflare account.

```
npx wrangler login
npx wrangler d1 create donate-plymouth
```

Copy the `database_id` it prints into `wrangler.toml`, then:

```
npm run db:remote
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put JUSTGIVING_APP_ID
npm run deploy
```

Use a long password. Anyone who has it can approve dares and change the donation links.

`npm run db:remote` only applies migrations that haven't been applied yet, so it is safe to run again after pulling new ones. Before you do that on a database with real donations in it, take a copy:

```
npx wrangler d1 export donate-plymouth --remote --output ../backup.sql
```

Keep the copy outside the repository. It has donors' names in it.

Never run `db/demo.sql` against the live database.

## Running it

Check the To do list regularly. Nothing appears publicly until a leader approves it, so a dare that's unsafe or unfair on someone can simply be turned down. The rules on the site also let you refuse a winning dare, in which case take it off the list and the next one moves up.

Ties go to the dare suggested first. A dare with no votes or confirmed money can't win.

Votes are one per dare per browser, and voting again takes the vote back. Someone determined could clear their browser data and vote again, which seems fine for a free vote about fancy dress.

After a dare board's closing time, new suggestions, votes and logged donations are refused, but leaders can still add late donations.

Limits are 20 suggestions, 40 logged donations and 300 votes an hour per internet connection. They're high because campus Wi-Fi can put a lot of people behind one address. To change them, edit the `enforceLimit` calls in `src/worker.js`.

## Files

- `src/worker.js`: the API, and the `/f/<slug>` pages
- `src/logic.js`: ranking, totals and input checks
- `test/`: unit tests, and API tests that run against SQLite
- `public/`: the site. `site.js` and `styles.css` are shared by every public page, and the admin page has its own `admin.js` and `admin.css`
- `migrations/`: the database schema
- `db/demo.sql`: made-up data for local previews
- `scripts/e2e.mjs`: checks against a running local copy
- `scripts/make-contours.mjs`: draws the contour lines in `public/contours.svg`
