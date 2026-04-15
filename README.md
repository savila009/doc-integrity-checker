# Document Integrity Checker

A simple local web app that helps detect suspicious edits within a single document (bank statements, pay stubs, and IDs) by:

1. Extracting text from one file (PDF or image)
2. Scanning for suspicious character/formatting/value patterns
3. Checking bank/payroll math consistency when key values are detected
4. Flagging employer legitimacy clues on pay stubs
5. Running ID authenticity checks for driver licenses/ID cards (issuer, date logic, ID pattern anomalies)
6. Producing a risk score, clue list, and page preview with highlighted suspicious areas

## Document Type Detection

- The app auto-detects document type after analysis:
  - Bank statement
  - Pay stub
  - Driver license / Identification card
  - Unknown
- The detected type and detection confidence are shown in the UI.

## Reliability Features

- **Detection confidence** is shown after each analysis.
- **High reliability (forensic) mode** runs additional OCR enhancement passes and picks the best extraction result for document analysis.
- For legal workflows, keep original files, store timestamps, and use independent/manual verification.

## Supported Files

- PDF (`.pdf`)
- Images (`.png`, `.jpg`, `.jpeg`, etc.)

## Run Locally

From the `doc-integrity-checker` folder:

```bash
python3 -m http.server 8080
```

Then open:

- `http://localhost:8080`

## Notes

- OCR can make mistakes on blurry scans; results should be reviewed manually.
- This tool is best as an initial risk flagger, not legal proof.
- For image-only PDFs, the app automatically falls back to OCR page-by-page.

## Add to GitHub

You need [Git](https://git-scm.com/) and a [GitHub](https://github.com/) account. On macOS, install **Xcode Command Line Tools** first if `git` is missing: `xcode-select --install`.

### 1. Create an empty repository on GitHub

1. Log in at [github.com](https://github.com).
2. Click **+** → **New repository**.
3. Name it (e.g. `doc-integrity-checker`).
4. Choose **Public** or **Private**.
5. Do **not** add a README, `.gitignore`, or license (this folder already has files).
6. Click **Create repository**.

### 2. Push this folder from your Mac

In Terminal (replace `YOUR_USERNAME` and `YOUR_REPO` with yours):

```bash
cd "/Users/shaneavila/Documents/doc-integrity-checker"

git init
git add .
git commit -m "Initial commit: Document Integrity Checker web app"

git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

GitHub may ask you to sign in. Use a **Personal Access Token** as the password if prompted (Settings → Developer settings → Personal access tokens), or use [GitHub CLI](https://cli.github.com/) (`gh auth login`).

### 3. Optional: GitHub Pages (share the app in a browser)

1. On the repo: **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Branch **main**, folder **/ (root)** → **Save**.
4. After a minute, the site URL appears (e.g. `https://YOUR_USERNAME.github.io/YOUR_REPO/`).

Treat uploaded documents as sensitive; use a **private** repo and access controls if needed.
