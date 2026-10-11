# Branchline

A 3D map of your team's AI chats. Every project is a tree. The head sets the root rules, everyone branches from them, and each branch's AI is silently given those rules plus the path it came from.

## Files

Everything sits in one folder, with no sub-folders:

```
server.js
index.html
package.json
render.yaml
.gitignore
README.md
```

## Run it (3 commands)

1. Install Node.js 18 or newer from https://nodejs.org
2. In the folder: `npm install`
3. `npm start`, then open http://localhost:3000

## How people use it

- **The first account is yours.** Open the app and press "Create account". After that, nobody else can sign up on their own.
- **You decide who gets in.** Open a project, press "Team and invite", fill in "Add a person" (their name, a username and a password, or leave the password empty for a random one) and press "Add person". Copy the login message and send it to that person privately. They log in and see only the projects you added them to. You can tick "Can edit the rules" for people you trust, press "New password" if someone forgets theirs, or "Remove" to take them out.
- **Invite link (optional):** the same box has a link that lets anyone who has it create an account and join that project. Press "Turn link off" if you only want people you added yourself.
- **The dashboard** lists every project you lead and every project you were added to. "New project" makes you its head, and you write its root rules.
- **The map:** each node shows its creator in brackets, for example "Pricing tiers (Ravi)". Click a node to read its description, who created it and what it branched from. "Branch from here" starts a new branch. "Open chat" opens a full-page chat for that node.
- **Permissions (enforced by the server):** members can read the whole project and write only in their own branches (or ones they were given access to). A locked result stays read-only, and only the head can unlock it. Only the head and people with an edit key can change the rules, and old rule versions can never be rewritten.

## Connect the AI (once, by you)

The first account created on the server is the AI admin, so **create your own account first**. After login press "AI settings" at the top, pick a provider, paste a key and press "Save and test". It tells you in plain words whether it worked. Everyone's chats then use that AI. The key never reaches anyone's browser.

| Provider | Cost | Notes |
| --- | --- | --- |
| Google Gemini | Free tier with rate limits | Key from https://aistudio.google.com/apikey. Google says free-tier content is used to improve its products. |
| Your own server (Ollama) | Free, unlimited, private | Install Ollama, run `ollama pull llama3.1`, choose "Your own server", address `http://localhost:11434/v1`, leave the key empty. Runs on the same computer as the app. |
| ChatGPT (OpenAI API) | Pay as you go | Key from https://platform.openai.com/api-keys. A ChatGPT subscription does not include API access, and there is no official way to use it in other apps. |

To change the AI later, open AI settings again and save. Everyone switches at once.

## Put it online for free (so friends on other computers can use it)

GitHub Pages, Vercel and Cloudflare Pages only host static pages or short-lived functions, so they cannot run this app (it needs a server that stays up and a database). This setup uses free services instead: GitHub holds the code, a MySQL database holds the data, Render runs the server.

1. **MySQL database (Aiven, free).** Sign up at https://aiven.io (no credit card), create a free MySQL service, and copy its connection details. Build one address from them: `mysql://USER:PASSWORD@HOST:PORT/defaultdb`. Aiven may power off a free service that is idle, and you can switch it back on in its console.
2. **GitHub.** Create a repository and upload `server.js`, `index.html`, `package.json`, `render.yaml`, `.gitignore` and `README.md`. Do not upload `node_modules`, `data` or `.env`.
3. **Render.** Sign up at https://render.com with GitHub. New, Web Service, pick your repository. Build command `npm install`, start command `npm start`, Free instance. Add the environment variable `DATABASE_URL` with your `mysql://...` address. Deploy.
4. Open the Render address (like `https://branchline-xxxx.onrender.com`). **The database starts empty, so create your account first.** Accounts you made on your own computer are not copied over. The first account becomes the AI admin.

Render's free server sleeps after 15 minutes without visitors, and the first visit afterwards takes about a minute. The data stays in MySQL.

## Seeing the database

- **In the app:** log in as the first account, press the AI button at the top ("AI not connected" or the model name), and press "Open the database view". It shows users, projects, members and branches, read-only, and never shows passwords.
- **In MySQL tools** (MySQL Workbench, DBeaver, HeidiSQL, phpMyAdmin): connect with the same host, port, user and password, using SSL. You will see readable tables `app_users`, `app_projects`, `app_members`, `app_branches` and `app_messages`. They are a read-only copy that the app refreshes after every change, so do not edit them. The app itself reads the `kv` table.

## Other ways to make it reachable

- **Same Wi-Fi:** open `http://YOUR-COMPUTER-IP:3000` and use that.
- **Your own computer, no hosting:** install Cloudflare's `cloudflared` (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), keep `npm start` running, and in a second window run `cloudflared tunnel --url http://localhost:3000`. It prints a temporary `https://....trycloudflare.com` address. Your computer must stay on.

## Good to know

- Run locally, all data lives in `data/state.json` (and `data/settings.json` for the AI key). Back them up. Online, it lives in your MySQL database instead.
- The head can set a new password for any person they created (Team and invite, then New password). People who joined with a link cannot reset their own password yet.
- One JSON file suits small teams. The AI is limited to 20 requests per minute per person.
