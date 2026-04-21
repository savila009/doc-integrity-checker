const docInput = document.getElementById("docFile");
const docTypeSelect = document.getElementById("docType");
const scanModeSelect = document.getElementById("scanMode");
const detectionConfidenceEl = document.getElementById("detectionConfidence");
const analyzeBtn = document.getElementById("analyzeBtn");
const docDropzone = document.getElementById("docDropzone");
const statusEl = document.getElementById("status");
const resultsCard = document.getElementById("resultsCard");
const riskScoreEl = document.getElementById("riskScore");
const totalFlagsEl = document.getElementById("totalFlags");
const textLengthEl = document.getElementById("textLength");
const analysisSummaryEl = document.getElementById("analysisSummary");
const issuesList = document.getElementById("issuesList");
const documentPreviewEl = document.getElementById("documentPreview");

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

setupDropzone(docDropzone, docInput);

analyzeBtn.addEventListener("click", async () => {
  const file = docInput.files?.[0];
  const selectedType = "auto";
  const scanMode = scanModeSelect?.value || "forensic";

  if (!file) {
    setStatus("Please upload one document first.");
    return;
  }

  try {
    setBusy(true);
    setStatus("Extracting document text...");
    const extracted = await extractDocumentData(file, selectedType, scanMode);

    setStatus("Analyzing for suspicious edit clues...");
    const report = await inspectDocument(extracted, selectedType, scanMode);
    const withHighlights = attachHighlights(report, extracted.pages);
    renderReport(withHighlights);
    syncDetectedTypeSelector(withHighlights.profile);
    setStatus("Analysis complete.");
  } catch (error) {
    console.error(error);
    setStatus(`Analysis failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
});

docInput.addEventListener("change", () => {
  updateDropzoneLabel(docDropzone, docInput.files?.[0]);
  if (docTypeSelect) {
    docTypeSelect.value = "auto";
  }
  if (detectionConfidenceEl) {
    detectionConfidenceEl.value = "Pending analysis";
  }
});

function setStatus(message) {
  statusEl.textContent = message;
}

function setBusy(busy) {
  analyzeBtn.disabled = busy;
  analyzeBtn.textContent = busy ? "Inspecting..." : "Inspect Document";
}

function syncDetectedTypeSelector(profile) {
  const detected = getDetectedTypeValue(profile);
  if (!docTypeSelect) {
    return;
  }
  docTypeSelect.value = detected;
}

function getDetectedTypeValue(profile) {
  if (!profile) {
    return "unknown";
  }
  if (profile.likelyId) {
    return "id";
  }
  if (profile.likelyBankStatement) {
    return "bank";
  }
  if (profile.likelyPayStub) {
    return "paystub";
  }
  return "unknown";
}

function setupDropzone(dropzoneEl, inputEl) {
  if (!dropzoneEl || !inputEl) {
    return;
  }

  dropzoneEl.addEventListener("click", () => inputEl.click());

  ["dragenter", "dragover"].forEach((eventName) => {
    dropzoneEl.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzoneEl.classList.add("dropzone--active");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzoneEl.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzoneEl.classList.remove("dropzone--active");
    });
  });

  dropzoneEl.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      return;
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    inputEl.files = dataTransfer.files;
    updateDropzoneLabel(dropzoneEl, file);
  });
}

function updateDropzoneLabel(dropzoneEl, file) {
  const textEl = dropzoneEl.querySelector("p");
  const hintEl = dropzoneEl.querySelector("small");
  if (!textEl || !hintEl) {
    return;
  }

  if (file) {
    textEl.textContent = file.name;
    hintEl.textContent = "Ready to analyze";
    dropzoneEl.classList.add("dropzone--has-file");
  } else {
    textEl.textContent = "Drag & drop file here";
    hintEl.textContent = "or click to choose";
    dropzoneEl.classList.remove("dropzone--has-file");
  }
}

async function extractDocumentData(file, selectedType, scanMode) {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return extractFromPdf(file, selectedType, scanMode);
  }

  if (file.type.startsWith("image/")) {
    return extractFromImage(file, selectedType, scanMode);
  }

  throw new Error(`Unsupported file type: ${file.type || file.name}`);
}

async function extractFromImage(file, selectedType, scanMode) {
  const imageBitmap = await createImageBitmap(file);
  const scale = selectedType === "id" ? (scanMode === "forensic" ? 3 : 2) : scanMode === "forensic" ? 2 : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(imageBitmap.width * scale);
  canvas.height = Math.round(imageBitmap.height * scale);
  const context = canvas.getContext("2d");
  context.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
  const bestResult = await runOcrWithOptionalIdEnhancement(
    canvas,
    selectedType,
    `OCR (${file.name})`,
    scanMode
  );

  return {
    text: normalizeText(bestResult.text),
    pages: [
      {
        pageNumber: 1,
        imageUrl: canvas.toDataURL("image/png"),
        width: canvas.width,
        height: canvas.height,
        words: normalizeOcrWords(bestResult.words),
      },
    ],
  };
}

async function extractFromPdf(file, selectedType, scanMode) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];
  let textParts = [];

  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
    setStatus(`Rendering PDF page ${pageIndex}/${pdf.numPages}...`);
    const page = await pdf.getPage(pageIndex);
    const baseScale = selectedType === "id" ? 2.5 : 1.8;
    const viewport = page.getViewport({ scale: scanMode === "forensic" ? baseScale + 0.8 : baseScale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;

    const bestResult = await runOcrWithOptionalIdEnhancement(
      canvas,
      selectedType,
      `OCR (${file.name}) page ${pageIndex}/${pdf.numPages}`,
      scanMode
    );

    textParts.push(bestResult.text);
    pages.push({
      pageNumber: pageIndex,
      imageUrl: canvas.toDataURL("image/png"),
      width: canvas.width,
      height: canvas.height,
      words: normalizeOcrWords(bestResult.words),
    });
  }

  return {
    text: normalizeText(textParts.join(" ")),
    pages,
  };
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeOcrWords(words) {
  return (words || [])
    .map((word) => ({
      text: (word.text || "").trim(),
      bbox: word.bbox || null,
    }))
    .filter((word) => word.text && word.bbox);
}

async function runOcrWithOptionalIdEnhancement(canvas, selectedType, statusLabel, scanMode) {
  const baseResult = await recognizeCanvas(canvas, selectedType === "id" ? "6" : "3", statusLabel);
  const shouldEnhance = scanMode === "forensic" || selectedType === "id" || looksLikeIdText(baseResult.text);

  if (!shouldEnhance) {
    return baseResult;
  }

  setStatus(`${statusLabel}: running ID enhancement mode...`);
  const enhancedModes =
    scanMode === "forensic"
      ? ["grayscale-contrast", "threshold", "adaptive-threshold", "sharpen"]
      : ["grayscale-contrast", "threshold"];
  let best = baseResult;
  let bestScore = scoreIdExtractionQuality(baseResult.text);

  for (const mode of enhancedModes) {
    const processedCanvas = preprocessCanvasForId(canvas, mode);
    const result = await recognizeCanvas(processedCanvas, "6", `${statusLabel} (${mode})`);
    const score = scoreIdExtractionQuality(result.text);
    if (score > bestScore || (score === bestScore && result.text.length > best.text.length)) {
      best = result;
      bestScore = score;
    }
  }

  return best;
}

async function recognizeCanvas(canvas, pageSegMode, statusLabel) {
  const {
    data: { text, words },
  } = await Tesseract.recognize(canvas, "eng", {
    tessedit_pageseg_mode: pageSegMode,
    logger: (m) => {
      if (m.status) {
        setStatus(`${statusLabel}: ${m.status}`);
      }
    },
  });

  return { text, words };
}

function preprocessCanvasForId(sourceCanvas, mode) {
  const canvas = document.createElement("canvas");
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const context = canvas.getContext("2d");
  context.drawImage(sourceCanvas, 0, 0);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    let value = gray;

    if (mode === "grayscale-contrast") {
      value = gray < 128 ? Math.max(0, gray - 35) : Math.min(255, gray + 35);
    } else if (mode === "threshold") {
      value = gray > 150 ? 255 : 0;
    } else if (mode === "adaptive-threshold") {
      value = gray > 135 ? 255 : 0;
    } else if (mode === "sharpen") {
      value = gray < 110 ? Math.max(0, gray - 45) : Math.min(255, gray + 20);
    }

    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

function looksLikeIdText(text) {
  const profile = detectDocumentProfile(text, "auto");
  return profile.likelyId || profile.idScore >= 2;
}

function scoreIdExtractionQuality(text) {
  const normalized = normalizeOcrForId(text);
  const fields = extractIdCoreFields(normalized, []);
  let score = 0;

  if (fields.dob) score += 4;
  if (fields.expiry) score += 4;
  if (fields.issueDate) score += 2;
  if (fields.sex) score += 2;
  if (fields.height) score += 3;
  if (fields.weight) score += 3;
  if (fields.eyes) score += 1;
  if (fields.hair) score += 1;

  const labels = ["dob", "date of birth", "expires", "exp", "iss", "sex", "hgt", "wgt"];
  for (const label of labels) {
    if (normalized.toLowerCase().includes(label)) {
      score += 1;
    }
  }

  return score;
}

async function inspectDocument(extracted, selectedType, scanMode) {
  const text = extracted.text;
  const profile = detectDocumentProfile(text, selectedType);
  const summary = buildAnalysisSummary(extracted, profile);
  let rawClues = [];

  if (profile.likelyId) {
    // IDs have very different structure from financial docs; generic money/date
    // heuristics create false positives, so use ID-focused checks only.
    rawClues = [...findIdAuthenticityClues(text, profile, summary.idFields)];
  } else {
    rawClues = [
      ...findConfusableCharacterClues(text),
      ...findTightPunctuationClues(text),
      ...findValueFormatSwitchClues(text),
      ...findAmountOutlierClues(text),
      ...findBankStatementMathClues(text, profile),
      ...findBankRunningBalanceClues(text, profile),
      ...findPayStubMathClues(text, profile),
      ...findPayStubLineItemClues(text, profile),
      ...findEmployerLegitimacyClues(text, profile),
    ];
    const externalClues = await findExternalEmployerVerificationClues(text, profile);
    rawClues.push(...externalClues);
  }

  const clues = rawClues.map((clue, index) => ({
    confidence: 0.6,
    ...clue,
    id: index + 1,
  }));

  const scoringClues = clues.filter((clue) => isScoringClue(clue));
  let riskScore = computeRiskScore(scoringClues, profile);

  if (profile.likelyId) {
    const hasOnlyExpiry = scoringClues.length === 1 && scoringClues[0].title === "ID appears expired";
    if (hasOnlyExpiry) {
      riskScore = 8;
    }
  }

  return {
    riskScore,
    totalFlags: scoringClues.length,
    textLength: text.length,
    clues: scoringClues.slice(0, 120),
    pages: [],
    profile,
    summary,
    detectionConfidence: computeDetectionConfidence(extracted, profile, summary, scanMode),
  };
}

function computeRiskScore(clues, profile) {
  const categoryCaps = {
    "ID authenticity": 45,
    "Bank math mismatch": 55,
    "Pay math mismatch": 55,
    "Employer legitimacy": 45,
    "Character anomaly": 35,
    "Formatting anomaly": 30,
    "Numeric anomaly": 35,
    "Format inconsistency": 30,
    "Bank anomaly": 35,
    "Pay anomaly": 35,
  };

  const categoryTotals = {};
  for (const clue of clues) {
    if (!isScoringClue(clue)) {
      continue;
    }
    const confidence = Number.isFinite(clue.confidence) ? clue.confidence : 0.8;
    const contribution = clue.weight * confidence * 3;
    const type = clue.type || "other";
    categoryTotals[type] = (categoryTotals[type] || 0) + contribution;
  }

  let total = 0;
  for (const [type, value] of Object.entries(categoryTotals)) {
    const cap = categoryCaps[type] ?? 30;
    total += Math.min(cap, value);
  }

  if (profile.likelyId) {
    total *= 0.9;
  }
  return Math.max(0, Math.min(100, Math.round(total)));
}

function isScoringClue(clue) {
  if (!clue || !Number.isFinite(clue.weight) || clue.weight <= 0) {
    return false;
  }
  const confidence = Number.isFinite(clue.confidence) ? clue.confidence : 0.6;
  return confidence >= 0.75;
}

function detectDocumentProfile(text, selectedType) {
  const lower = text.toLowerCase();
  const bankHits = [
    "account number",
    "statement period",
    "beginning balance",
    "ending balance",
    "debit",
    "credit",
    "withdrawal",
    "deposit",
    "available balance",
    "routing number",
  ].filter((keyword) => lower.includes(keyword)).length;

  const payStubHits = [
    "pay stub",
    "pay period",
    "employee",
    "employer",
    "gross pay",
    "net pay",
    "federal tax",
    "state tax",
    "deduction",
    "hourly rate",
    "ytd",
  ].filter((keyword) => lower.includes(keyword)).length;

  const idHits = [
    "driver license",
    "driver's license",
    "identification card",
    "date of birth",
    "dob",
    "class",
    "endorsement",
    "restrictions",
    "expires",
    "sex",
    "height",
    "weight",
    "eyes",
    "hair",
    "iss",
    "dd",
    "dl",
  ].filter((keyword) => lower.includes(keyword)).length;

  return {
    bankScore: bankHits,
    payStubScore: payStubHits,
    idScore: idHits,
    selectedType,
    likelyBankStatement:
      selectedType === "bank" || (selectedType === "auto" && bankHits >= 3 && bankHits >= payStubHits && bankHits >= idHits),
    likelyPayStub:
      selectedType === "paystub" || (selectedType === "auto" && payStubHits >= 3 && payStubHits >= bankHits && payStubHits >= idHits),
    likelyId:
      selectedType === "id" || (selectedType === "auto" && idHits >= 2 && idHits >= bankHits && idHits >= payStubHits),
  };
}

function findConfusableCharacterClues(text) {
  const patterns = [
    { regex: /\b[0-9]*[OIl][0-9]+\b/g, clue: "Possible O/0 or I/1 substitution near digits", weight: 7 },
    { regex: /\b[A-Z]{2,}[0-9][A-Z][0-9]+\b/g, clue: "Mixed letter/number identifier with confusable glyphs", weight: 5 },
    { regex: /\b[0-9]+[A-Za-z][0-9]+\b/g, clue: "Single letter inserted between digits", weight: 5 },
  ];
  return collectPatternClues(text, patterns, "Character anomaly");
}

function findTightPunctuationClues(text) {
  const patterns = [
    { regex: /\d[.,:;]\d[.,:;]\d/g, clue: "Repeated punctuation inside number sequence", weight: 4 },
    {
      regex: /[$€£]\s?\d{1,3}(,\d{3})*(\.\d{2})?\s?[.,:;]{1,2}/g,
      clue: "Money value followed by unusual punctuation",
      weight: 0,
    },
    { regex: /[_-]{3,}/g, clue: "Long underline/dash run often used to patch text", weight: 3 },
  ];
  return collectPatternClues(text, patterns, "Formatting anomaly");
}

function findValueFormatSwitchClues(text) {
  const patterns = [
    { regex: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, clue: "Slash-based date format", weight: 2 },
    { regex: /\b\d{4}-\d{2}-\d{2}\b/g, clue: "ISO date format", weight: 2 },
    { regex: /\b\d{1,3}(,\d{3})+(\.\d{2})\b/g, clue: "US numeric money format", weight: 2 },
    { regex: /\b\d{1,3}(\.\d{3})+(,\d{2})\b/g, clue: "EU numeric money format", weight: 2 },
  ];

  const raw = collectPatternClues(text, patterns, "Format inconsistency");
  const hasSlashDates = raw.some((r) => r.snippet.match(/\//));
  const hasIsoDates = raw.some((r) => r.snippet.match(/\d{4}-\d{2}-\d{2}/));
  const hasUsMoney = raw.some((r) => r.snippet.match(/,\d{3}(\.\d{2})/));
  const hasEuMoney = raw.some((r) => r.snippet.match(/\.\d{3}(,\d{2})/));

  const extra = [];
  if (hasSlashDates && hasIsoDates) {
    extra.push({
      type: "Format inconsistency",
      title: "Mixed date formats found in one document",
      snippet: "Detected both MM/DD/YYYY and YYYY-MM-DD patterns.",
      weight: 6,
    });
  }
  if (hasUsMoney && hasEuMoney) {
    extra.push({
      type: "Format inconsistency",
      title: "Mixed money number formats found",
      snippet: "Detected both 1,234.56 and 1.234,56 style values.",
      weight: 6,
    });
  }

  return [...raw, ...extra];
}

function findAmountOutlierClues(text) {
  const moneyRegex = /\b\d{1,3}(?:,\d{3})*(?:\.\d{2})\b/g;
  const matches = [...text.matchAll(moneyRegex)].map((m) => Number(m[0].replace(/,/g, "")));
  if (matches.length < 4) {
    return [];
  }

  const median = getMedian(matches);
  if (!Number.isFinite(median) || median === 0) {
    return [];
  }

  const outliers = matches
    .filter((value) => value / median >= 25 || median / value >= 25)
    .slice(0, 12);

  return outliers.map((value) => ({
    type: "Numeric anomaly",
    title: "Large amount outlier compared with other values",
    snippet: `Detected amount ${value.toFixed(2)} with unusually large ratio from median ${median.toFixed(2)}.`,
    weight: 5,
  }));
}

function findBankStatementMathClues(text, profile) {
  if (!profile.likelyBankStatement) {
    return [];
  }

  const clues = [];
  const opening = getPrimaryAmountByKeywords(text, ["beginning balance", "opening balance", "starting balance"]);
  const deposits = getPrimaryAmountByKeywords(text, ["total deposits", "credits", "total credits", "deposits"]);
  const withdrawals = getPrimaryAmountByKeywords(text, ["total withdrawals", "debits", "total debits", "withdrawals"]);
  const closing = getPrimaryAmountByKeywords(text, ["ending balance", "closing balance", "new balance"]);
  const period = extractStatementPeriod(text);

  if ([opening, deposits, withdrawals, closing].every((n) => Number.isFinite(n))) {
    const expectedCents = toCents(opening) + toCents(deposits) - toCents(withdrawals);
    const closingCents = toCents(closing);
    const deltaCents = Math.abs(expectedCents - closingCents);
    if (deltaCents >= 2) {
      clues.push({
        type: "Bank math mismatch",
        title: "Balances do not reconcile (opening + deposits - withdrawals != ending)",
        snippet: `Opening ${toMoney(opening)}, deposits ${toMoney(deposits)}, withdrawals ${toMoney(withdrawals)}, ending ${toMoney(
          closing
        )}, mismatch ${toMoney(deltaCents / 100)}.`,
        rawMatch: `ending balance ${toMoney(closing)}`,
        weight: 10,
        confidence: 0.95,
      });
    }
  }

  const available = getPrimaryAmountByKeywords(text, ["available balance"]);
  if (Number.isFinite(available) && Number.isFinite(closing)) {
    const spread = Math.abs(available - closing);
    if (spread > Math.max(5000, Math.abs(closing) * 5)) {
      clues.push({
        type: "Bank anomaly",
        title: "Available balance is unusually far from ending balance",
        snippet: `Available ${toMoney(available)} vs ending ${toMoney(closing)}.`,
        rawMatch: `available balance ${toMoney(available)}`,
        weight: 5,
        confidence: 0.7,
      });
    }
  }

  if (period && period.start && period.end) {
    const days = Math.round((period.end - period.start) / (1000 * 60 * 60 * 24));
    if (days < 0 || days > 45) {
      clues.push({
        type: "Bank anomaly",
        title: "Statement period length looks abnormal",
        snippet: `Detected period ${formatDateIso(period.start)} to ${formatDateIso(period.end)} (${days} days).`,
        weight: 6,
        confidence: 0.9,
      });
    }
  }

  return clues;
}

function findBankRunningBalanceClues(text, profile) {
  if (!profile.likelyBankStatement) {
    return [];
  }

  const rows = extractBankTransactionRows(text);
  if (rows.length < 3) {
    return [];
  }

  const clues = [];
  const opening = getPrimaryAmountByKeywords(text, ["beginning balance", "opening balance", "starting balance"]);

  if (Number.isFinite(opening)) {
    const firstRow = rows[0];
    const firstEval = evaluateRunningBalanceStep(opening, firstRow);
    if (!firstEval.withinTolerance) {
      clues.push({
        type: "Bank math mismatch",
        title: "First transaction does not reconcile with opening balance",
        snippet: `Opening ${toMoney(opening)}, transaction ${firstRow.amountRaw}, resulting balance ${toMoney(firstRow.balance)}.`,
        rawMatch: firstRow.raw,
        weight: 8,
        confidence: 0.85,
      });
    }
  }

  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const curr = rows[i];
    const evaluation = evaluateRunningBalanceStep(prev.balance, curr);
    if (!evaluation.withinTolerance) {
      clues.push({
        type: "Bank math mismatch",
        title: "Transaction amount does not reconcile with running balance",
        snippet: `Prior balance ${toMoney(prev.balance)}, transaction ${curr.amountRaw}, next balance ${toMoney(curr.balance)}.`,
        rawMatch: curr.raw,
        weight: 8,
        confidence: 0.84,
      });
    }
    if (clues.length >= 8) {
      break;
    }
  }

  return clues;
}

function extractBankTransactionRows(text) {
  const rows = [];
  const rowRegex =
    /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+([A-Za-z0-9&.,'()#\-\/ ]{2,65}?)\s+(\(?-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?\s*(?:cr|dr)?)\s+(\(?-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?)/gi;

  for (const match of text.matchAll(rowRegex)) {
    const amountInfo = parseTransactionAmountToken(match[3]);
    const balance = parseMoney(match[4].replace(/[()$]/g, ""));
    if (!Number.isFinite(amountInfo.absolute) || !Number.isFinite(balance)) {
      continue;
    }
    rows.push({
      date: match[1],
      description: match[2].trim(),
      amountRaw: match[3].trim(),
      amountInfo,
      balance,
      raw: match[0],
    });
    if (rows.length >= 70) {
      break;
    }
  }

  return rows;
}

function parseTransactionAmountToken(token) {
  const lower = token.toLowerCase();
  const hasParens = /\(.*\)/.test(token);
  const hasMinus = /\-/.test(token);
  const hasDebit = /\bdr\b/.test(lower);
  const hasCredit = /\bcr\b/.test(lower);
  const numeric = parseMoney(token.replace(/[()$]/g, "").replace(/\b(cr|dr)\b/gi, "").trim());
  const absolute = Number.isFinite(numeric) ? Math.abs(numeric) : NaN;

  if (!Number.isFinite(absolute)) {
    return { absolute: NaN, candidates: [], signKnown: false };
  }
  if (hasDebit || hasParens || hasMinus) {
    return { absolute, candidates: [-absolute], signKnown: true };
  }
  if (hasCredit) {
    return { absolute, candidates: [absolute], signKnown: true };
  }
  return { absolute, candidates: [absolute, -absolute], signKnown: false };
}

function evaluateRunningBalanceStep(previousBalance, row) {
  const descriptor = (row.description || "").toLowerCase();
  let candidateAmounts = [...row.amountInfo.candidates];
  if (!row.amountInfo.signKnown) {
    if (/(debit|withdrawal|purchase|pos|atm|fee|payment)/i.test(descriptor)) {
      candidateAmounts = [-row.amountInfo.absolute];
    } else if (/(deposit|credit|refund|reversal|payroll)/i.test(descriptor)) {
      candidateAmounts = [row.amountInfo.absolute];
    }
  }
  if (!candidateAmounts.length) {
    candidateAmounts = [row.amountInfo.absolute, -row.amountInfo.absolute];
  }

  const previousCents = toCents(previousBalance);
  const rowBalanceCents = toCents(row.balance);
  let bestDeltaCents = Number.POSITIVE_INFINITY;
  for (const amount of candidateAmounts) {
    const expectedCents = previousCents + toCents(amount);
    const deltaCents = Math.abs(expectedCents - rowBalanceCents);
    if (deltaCents < bestDeltaCents) {
      bestDeltaCents = deltaCents;
    }
  }
  const toleranceCents = row.amountInfo.signKnown ? 1 : 2;
  return {
    deltaCents: bestDeltaCents,
    toleranceCents,
    withinTolerance: bestDeltaCents <= toleranceCents,
  };
}

function findPayStubMathClues(text, profile) {
  if (!profile.likelyPayStub) {
    return [];
  }

  const clues = [];
  const gross = getPrimaryAmountByKeywords(text, ["gross pay", "current gross"]);
  const net = getPrimaryAmountByKeywords(text, ["net pay", "take home pay"]);
  const deductions = getPrimaryAmountByKeywords(text, ["total deductions", "deductions"]);
  const hours = getPrimaryNumericByKeywords(text, ["hours", "regular hours", "hrs"]);
  const rate = getPrimaryAmountByKeywords(text, ["hourly rate", "rate"]);

  if ([gross, net, deductions].every((n) => Number.isFinite(n))) {
    const expectedNet = gross - deductions;
    const delta = Math.abs(expectedNet - net);
    const tolerance = Math.max(0.75, Math.abs(gross) * 0.01);
    if (delta > tolerance) {
      clues.push({
        type: "Pay math mismatch",
        title: "Gross pay minus deductions does not match net pay",
        snippet: `Gross ${toMoney(gross)}, deductions ${toMoney(deductions)}, net ${toMoney(net)}.`,
        rawMatch: `net pay ${toMoney(net)}`,
        weight: 10,
        confidence: 0.95,
      });
    }
  }

  const ytdGross = getPrimaryAmountByKeywords(text, ["ytd gross", "gross ytd", "year to date gross"]);
  if (Number.isFinite(ytdGross) && Number.isFinite(gross) && ytdGross < gross) {
    clues.push({
      type: "Pay anomaly",
      title: "YTD gross appears lower than current gross pay",
      snippet: `Current gross ${toMoney(gross)} exceeds YTD gross ${toMoney(ytdGross)}.`,
      rawMatch: `ytd gross ${toMoney(ytdGross)}`,
      weight: 7,
      confidence: 0.85,
    });
  }

  if (Number.isFinite(hours) && Number.isFinite(rate) && Number.isFinite(gross)) {
    const expectedGross = hours * rate;
    const delta = Math.abs(expectedGross - gross);
    const tolerance = Math.max(2.0, expectedGross * 0.03);
    if (delta > tolerance) {
      clues.push({
        type: "Pay math mismatch",
        title: "Hours x hourly rate does not align with gross pay",
        snippet: `Hours ${hours}, rate ${toMoney(rate)}, gross ${toMoney(gross)}.`,
        weight: 8,
        confidence: 0.8,
      });
    }
  }

  const ytdNet = getPrimaryAmountByKeywords(text, ["ytd net", "net ytd", "year to date net"]);
  if (Number.isFinite(ytdNet) && Number.isFinite(net) && ytdNet < net) {
    clues.push({
      type: "Pay anomaly",
      title: "YTD net appears lower than current net pay",
      snippet: `Current net ${toMoney(net)} exceeds YTD net ${toMoney(ytdNet)}.`,
      weight: 7,
      confidence: 0.85,
    });
  }

  return clues;
}

function findPayStubLineItemClues(text, profile) {
  if (!profile.likelyPayStub) {
    return [];
  }

  const clues = [];
  const deductionTotal = getPrimaryAmountByKeywords(text, ["total deductions", "deductions"]);
  const gross = getPrimaryAmountByKeywords(text, ["gross pay", "current gross"]);

  const deductionItems = collectPayLineItemsByKeywords(text, [
    "federal tax",
    "state tax",
    "local tax",
    "social security",
    "medicare",
    "insurance",
    "dental",
    "vision",
    "retirement",
    "401k",
    "garnishment",
  ]);

  if (Number.isFinite(deductionTotal) && deductionItems.length >= 2) {
    const deducedTotal = deductionItems.reduce((sum, item) => sum + item.value, 0);
    const delta = Math.abs(deducedTotal - deductionTotal);
    const tolerance = Math.max(1.0, deductionTotal * 0.03);
    if (delta > tolerance) {
      clues.push({
        type: "Pay math mismatch",
        title: "Deduction line items do not add up to total deductions",
        snippet: `Line items ${toMoney(deducedTotal)} vs total deductions ${toMoney(deductionTotal)}.`,
        rawMatch: deductionItems[0].raw,
        weight: 9,
        confidence: 0.9,
      });
    }
  }

  const earningItems = collectPayLineItemsByKeywords(text, [
    "regular pay",
    "overtime",
    "bonus",
    "commission",
    "holiday pay",
    "vacation pay",
    "sick pay",
    "shift differential",
  ]);

  if (Number.isFinite(gross) && earningItems.length >= 2) {
    const summedEarnings = earningItems.reduce((sum, item) => sum + item.value, 0);
    const delta = Math.abs(summedEarnings - gross);
    const tolerance = Math.max(1.25, gross * 0.03);
    if (delta > tolerance) {
      clues.push({
        type: "Pay math mismatch",
        title: "Earning components do not add up to gross pay",
        snippet: `Line items ${toMoney(summedEarnings)} vs gross pay ${toMoney(gross)}.`,
        rawMatch: earningItems[0].raw,
        weight: 8,
        confidence: 0.86,
      });
    }
  }

  return clues;
}

function collectPayLineItemsByKeywords(text, keywords) {
  const values = [];
  const seen = new Set();
  for (const keyword of keywords) {
    const escaped = escapeRegExp(keyword);
    const regex = new RegExp(`${escaped}[\\s:\\-]{0,10}(?:[$€£]\\s*)?(-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?)`, "gi");
    for (const match of text.matchAll(regex)) {
      const before = text.slice(Math.max(0, match.index - 18), match.index).toLowerCase();
      if (before.includes("ytd") || before.includes("year to date")) {
        continue;
      }
      if (/total|current|gross pay|net pay/i.test(match[0])) {
        continue;
      }
      const numeric = parseMoney(match[1]);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        continue;
      }
      const rounded = numeric.toFixed(2);
      const dedupeKey = `${keyword}:${rounded}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      values.push({
        keyword,
        value: numeric,
        raw: match[0],
      });
      if (values.length >= 25) {
        return values;
      }
    }
  }
  return values;
}

function findEmployerLegitimacyClues(text, profile) {
  if (!profile.likelyPayStub) {
    return [];
  }

  const clues = [];
  const lower = text.toLowerCase();
  const employerChunkMatch = text.match(/(?:employer|company|business)\s*[:\-]?\s*([A-Za-z0-9&.,'\-\s]{3,70})/i);
  const employerName = employerChunkMatch ? employerChunkMatch[1].trim() : "";

  const freeEmailRegex = /\b[A-Za-z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|icloud|aol)\.com\b/gi;
  for (const match of text.matchAll(freeEmailRegex)) {
    clues.push({
      type: "Employer legitimacy",
      title: "Employer contact uses a free email domain",
      snippet: match[0],
      rawMatch: match[0],
      weight: 6,
      confidence: 0.9,
    });
  }

  if (!employerName) {
    clues.push({
      type: "Employer legitimacy",
      title: "No clear employer/company name found on pay stub",
      snippet: "Could not confidently extract an employer name from text.",
      weight: 7,
      confidence: 0.6,
    });
  } else {
    const hasEntitySuffix = /\b(inc|llc|ltd|corp|corporation|co|company)\b/i.test(employerName);
    const hasManyDigits = (employerName.match(/\d/g) || []).length >= 4;
    const weirdRepeats = /(.)\1\1/i.test(employerName);
    if (!hasEntitySuffix && (hasManyDigits || weirdRepeats)) {
      clues.push({
        type: "Employer legitimacy",
        title: "Employer name looks synthetic or low credibility",
        snippet: employerName,
        rawMatch: employerName,
        weight: 6,
        confidence: 0.7,
      });
    }
  }

  const einMatch = text.match(/\b\d{2}-\d{7}\b/);
  if (!einMatch) {
    clues.push({
      type: "Employer legitimacy",
      title: "No EIN pattern detected on pay stub",
      snippet: "Missing expected employer tax ID format XX-XXXXXXX.",
      weight: 4,
      confidence: 0.65,
    });
  }

  const phoneMatches = [...text.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g)];
  const invalidPhone = phoneMatches.find((m) => /(\d)\1{6,}/.test(m[0].replace(/\D/g, "")));
  if (invalidPhone) {
    clues.push({
      type: "Employer legitimacy",
      title: "Phone number looks invalid (repeating digits)",
      snippet: invalidPhone[0],
      rawMatch: invalidPhone[0],
      weight: 5,
      confidence: 0.85,
    });
  }

  if (!lower.includes("address") && !/\b\d{2,6}\s+[a-z]/i.test(text)) {
    clues.push({
      type: "Employer legitimacy",
      title: "Employer mailing address not clearly present",
      snippet: "Missing clear street/address pattern.",
      weight: 4,
      confidence: 0.6,
    });
  }

  return clues;
}

async function findExternalEmployerVerificationClues(text, profile) {
  if (!profile.likelyPayStub) {
    return [];
  }

  const employerName = extractEmployerNameForVerification(text);
  if (!employerName || isGenericEmployerLabel(employerName)) {
    return [];
  }

  try {
    const result = await evaluateEmployerPresence(employerName);
    if (result.status !== "not_found") {
      return [];
    }

    const synthetic = looksSyntheticEmployerName(employerName);
    if (synthetic) {
      return [
        {
          type: "Employer legitimacy",
          title: "Employer name not found in public search and appears synthetic",
          snippet: `${employerName} (no strong public search match)`,
          rawMatch: employerName,
          weight: 8,
          confidence: 0.82,
        },
      ];
    }

    return [
      {
        type: "Employer legitimacy",
        title: "No strong public reference found for employer name",
        snippet: `${employerName} (manual verification recommended)`,
        rawMatch: employerName,
        weight: 0,
        confidence: 0.65,
      },
    ];
  } catch (error) {
    // Network access is optional for this signal; local checks still run.
    return [];
  }
}

function extractEmployerNameForVerification(text) {
  const explicit = text.match(/(?:employer|company|business)\s*[:\-]?\s*([A-Za-z0-9&.,'\-\s]{3,70})/i);
  if (explicit && explicit[1]) {
    return explicit[1].trim().replace(/\s+/g, " ");
  }

  const domainEmail = text.match(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
  if (domainEmail && domainEmail[1]) {
    const domain = domainEmail[1].toLowerCase();
    if (!/(gmail|yahoo|hotmail|outlook|icloud|aol)\.com$/.test(domain)) {
      const root = domain.replace(/\.(com|net|org|co|io|us|biz)$/i, "");
      return root.replace(/[-_.]+/g, " ").trim();
    }
  }

  return "";
}

function isGenericEmployerLabel(name) {
  const normalized = normalizeCompanyName(name);
  const genericOnly = ["employer", "company", "business", "payroll", "hr", "human resources"];
  return genericOnly.includes(normalized) || normalized.length < 4;
}

function looksSyntheticEmployerName(name) {
  const cleaned = name.trim();
  const hasEntitySuffix = /\b(inc|llc|ltd|corp|corporation|co|company)\b/i.test(cleaned);
  const hasManyDigits = (cleaned.match(/\d/g) || []).length >= 4;
  const weirdRepeats = /(.)\1\1/i.test(cleaned);
  return !hasEntitySuffix && (hasManyDigits || weirdRepeats);
}

async function evaluateEmployerPresence(name) {
  const query = encodeURIComponent(`"${name}" company`);
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${query}&srlimit=5&format=json&origin=*`;
  const payload = await fetchJsonWithTimeout(url, 6500);
  const searchResults = payload?.query?.search || [];

  if (!searchResults.length) {
    return { status: "not_found", score: 0 };
  }

  const employerTokens = tokenizeCompanyName(name);
  let bestScore = 0;
  for (const result of searchResults) {
    const titleTokens = tokenizeCompanyName(result.title || "");
    const overlap = tokenOverlapRatio(employerTokens, titleTokens);
    if (overlap > bestScore) {
      bestScore = overlap;
    }
  }

  if (bestScore >= 0.6) {
    return { status: "found", score: bestScore };
  }
  if (bestScore >= 0.35 || searchResults.length >= 4) {
    return { status: "weak_match", score: bestScore };
  }
  return { status: "not_found", score: bestScore };
}

function normalizeCompanyName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeCompanyName(value) {
  const normalized = normalizeCompanyName(value);
  if (!normalized) {
    return [];
  }
  return normalized.split(" ").filter(Boolean);
}

function tokenOverlapRatio(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) {
    return 0;
  }
  const bSet = new Set(bTokens);
  let overlap = 0;
  for (const token of new Set(aTokens)) {
    if (bSet.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(1, new Set(aTokens).size);
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function findIdAuthenticityClues(text, profile, existingCoreFields) {
  if (!profile.likelyId) {
    return [];
  }

  const clues = [];
  const coreFields = existingCoreFields || extractIdCoreFields(text);

  const hasIssuer =
    /\bdepartment of motor vehicles\b/i.test(text) ||
    /\bdmv\b/i.test(text) ||
    /\bstate of [a-z ]+\b/i.test(text);
  if (!hasIssuer) {
    clues.push({
      type: "ID authenticity",
      title: "No clear issuing authority found",
      snippet: "Expected issuer text like DMV or State of ...",
      weight: 0,
    });
  }

  const idNumberMatch = text.match(
    /(?:dl|lic(?:ense)?|id(?:entification)?)[\s#:.-]{0,8}([A-Z0-9-]{5,20})/i
  );
  if (!idNumberMatch) {
    clues.push({
      type: "ID authenticity",
      title: "Could not detect a plausible license/ID number",
      snippet: "Missing detectable DL/ID number pattern.",
      weight: 0,
    });
  } else {
    const idNumber = idNumberMatch[1];
    if (/([A-Z0-9])\1{4,}/i.test(idNumber)) {
      clues.push({
        type: "ID authenticity",
        title: "ID number has suspicious repeated characters",
        snippet: idNumber,
        rawMatch: idNumber,
        weight: 7,
        confidence: 0.9,
      });
    }
    if (/[OIl]/.test(idNumber) && /\d/.test(idNumber)) {
      clues.push({
        type: "ID authenticity",
        title: "ID number contains OCR-confusable characters (O/0, I/1, l/1)",
        snippet: idNumber,
        rawMatch: idNumber,
        weight: 0,
      });
    }
  }

  const dob = coreFields.dob;
  const expiry = coreFields.expiry;
  const issue = coreFields.issueDate;

  if (!dob) {
    clues.push({
      type: "ID authenticity",
      title: "Date of birth not clearly detected",
      snippet: "Missing DOB marker and recognizable date.",
      weight: 0,
    });
  }
  if (!expiry) {
    clues.push({
      type: "ID authenticity",
      title: "Expiration date not clearly detected",
      snippet: "Missing EXP/Expires marker and recognizable date.",
      weight: 0,
    });
  }

  if (dob && expiry && expiry <= dob) {
    clues.push({
      type: "ID authenticity",
      title: "Expiration date is earlier than date of birth",
      snippet: `DOB ${formatDateIso(dob)} vs EXP ${formatDateIso(expiry)}.`,
      weight: 10,
      confidence: 0.98,
    });
  }

  const now = new Date();
  if (expiry && expiry < now) {
    clues.push({
      type: "ID authenticity",
      title: "ID appears expired",
      snippet: `Expiration ${formatDateIso(expiry)} is in the past.`,
      weight: 2,
      confidence: 0.95,
    });
  }

  if (dob) {
    const age = calculateAge(dob, now);
    if (age < 16) {
      clues.push({
        type: "ID authenticity",
        title: "DOB implies an unusually young age for a driver license",
        snippet: `Detected age approximately ${age}.`,
        weight: 8,
        confidence: 0.9,
      });
    }
  }

  if (issue && expiry && issue >= expiry) {
    clues.push({
      type: "ID authenticity",
      title: "Issue date is not earlier than expiration date",
      snippet: `Issue ${formatDateIso(issue)} vs EXP ${formatDateIso(expiry)}.`,
      weight: 9,
      confidence: 0.95,
    });
  }

  const hasCoreFields =
    Boolean(dob) &&
    Boolean(expiry) &&
    Boolean(coreFields.height) &&
    Boolean(coreFields.weight) &&
    Boolean(coreFields.sex);
  if (!hasCoreFields) {
    clues.push({
      type: "ID authenticity",
      title: "Missing one or more key ID fields",
      snippet: `Detected fields -> DOB: ${Boolean(dob)}, EXP: ${Boolean(expiry)}, SEX: ${Boolean(
        coreFields.sex
      )}, HGT: ${Boolean(coreFields.height)}, WGT: ${Boolean(coreFields.weight)}.`,
      weight: 0,
    });
  }

  if (coreFields.height && !isPlausibleHeight(coreFields.height)) {
    clues.push({
      type: "ID authenticity",
      title: "Height value appears implausible",
      snippet: coreFields.height.raw,
      rawMatch: coreFields.height.raw,
      weight: 6,
      confidence: 0.85,
    });
  }

  if (coreFields.weight && !isPlausibleWeight(coreFields.weight)) {
    clues.push({
      type: "ID authenticity",
      title: "Weight value appears implausible",
      snippet: coreFields.weight.raw,
      rawMatch: coreFields.weight.raw,
      weight: 6,
      confidence: 0.85,
    });
  }

  return clues;
}

function getPrimaryAmountByKeywords(text, keywords) {
  const amounts = [];
  for (const keyword of keywords) {
    const escaped = escapeRegExp(keyword);
    const regex = new RegExp(`${escaped}[\\s:\\-]{0,8}(?:[$€£]\\s*)?(-?\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?)`, "gi");
    for (const match of text.matchAll(regex)) {
      const value = parseMoney(match[1]);
      if (Number.isFinite(value)) {
        amounts.push(value);
      }
    }
  }
  if (!amounts.length) {
    return NaN;
  }
  return amounts[0];
}

function getPrimaryNumericByKeywords(text, keywords) {
  const values = [];
  for (const keyword of keywords) {
    const escaped = escapeRegExp(keyword);
    const regex = new RegExp(`${escaped}[\\s:\\-]{0,8}(-?\\d{1,3}(?:\\.\\d{1,2})?)`, "gi");
    for (const match of text.matchAll(regex)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) {
        values.push(value);
      }
    }
  }
  return values.length ? values[0] : NaN;
}

function extractStatementPeriod(text) {
  const periodMatch = text.match(
    /statement period[^0-9]{0,20}(\d{1,2}\/\d{1,2}\/\d{2,4})[^0-9]{1,12}(\d{1,2}\/\d{1,2}\/\d{2,4})/i
  );
  if (!periodMatch) {
    return null;
  }
  const start = parseDateText(periodMatch[1]);
  const end = parseDateText(periodMatch[2]);
  return start && end ? { start, end } : null;
}

function parseMoney(value) {
  if (!value) {
    return NaN;
  }
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function toCents(value) {
  if (!Number.isFinite(value)) {
    return NaN;
  }
  return Math.round((value + Number.EPSILON) * 100);
}

function toMoney(value) {
  return Number(value).toFixed(2);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractDates(text) {
  const values = new Set();
  const slash = [...text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g)];
  const dash = [...text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)];

  for (const m of slash) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) {
      year += year > 40 ? 1900 : 2000;
    }
    const d = buildUtcDate(year, month, day);
    if (d) {
      values.add(d.toISOString());
    }
  }

  for (const m of dash) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const d = buildUtcDate(year, month, day);
    if (d) {
      values.add(d.toISOString());
    }
  }

  return [...values].map((iso) => new Date(iso));
}

function normalizeOcrForId(value) {
  return value
    .replace(/[|]/g, "1")
    .replace(/[Oo](?=\d)/g, "0")
    .replace(/(?<=\d)[Oo]/g, "0")
    .replace(/[Il](?=\d)/g, "1")
    .replace(/(?<=\d)[Il]/g, "1");
}

function extractIdCoreFields(text, pages = []) {
  const normalized = normalizeOcrForId(text);
  const lines = buildOcrLinesFromPages(pages);
  const dobText = findValueNearField(lines, normalized, ["date of birth", "dob", "birth", "born"], "date");
  const expText = findValueNearField(lines, normalized, ["expires", "expiration", "exp"], "date");
  const issText = findValueNearField(lines, normalized, ["issued", "iss", "issue date"], "date");
  const sexText = findValueNearField(lines, normalized, ["sex", "gender"], "sex");
  const heightText = findValueNearField(lines, normalized, ["height", "hgt", "ht"], "height");
  const weightText = findValueNearField(lines, normalized, ["weight", "wgt", "wt"], "weight");
  const eyesText = findValueNearField(lines, normalized, ["eyes", "eye"], "alpha");
  const hairText = findValueNearField(lines, normalized, ["hair"], "alpha");

  const dob =
    parseDateText(dobText) ||
    findDateNearKeywords(extractDates(normalized), normalized, ["date of birth", "dob", "birth", "born"]);
  const expiry =
    parseDateText(expText) || findDateNearKeywords(extractDates(normalized), normalized, ["expires", "expiration", "exp"]);
  const issueDate =
    parseDateText(issText) || findDateNearKeywords(extractDates(normalized), normalized, ["issued", "iss", "issue date"]);

  const sexMatch =
    (sexText && sexText.match(/\b(male|female|m|f|x)\b/i)) ||
    normalized.match(/\b(?:sex|gender)\s*[:\-]?\s*(male|female|m|f|x)\b/i);
  const sex = sexMatch ? sexMatch[1].toUpperCase() : "";

  const height = extractHeight(heightText || normalized);
  const weight = extractWeight(weightText || normalized);
  const eyesMatch =
    (eyesText && eyesText.match(/\b([A-Z]{3}|blue|brown|green|hazel|gry|blk|blu|bro)\b/i)) ||
    normalized.match(/\b(?:eyes?|eye)\s*[:\-]?\s*([A-Z]{3}|blue|brown|green|hazel|gry|blk|blu|bro)\b/i);
  const hairMatch =
    (hairText && hairText.match(/\b([A-Z]{3}|black|brown|blond|gray|red|blk|bro|bln|gry)\b/i)) ||
    normalized.match(/\bhair\s*[:\-]?\s*([A-Z]{3}|black|brown|blond|gray|red|blk|bro|bln|gry)\b/i);

  return {
    dob,
    expiry,
    issueDate,
    sex,
    height,
    weight,
    eyes: eyesMatch ? eyesMatch[1].toUpperCase() : "",
    hair: hairMatch ? hairMatch[1].toUpperCase() : "",
  };
}

function buildOcrLinesFromPages(pages) {
  const lines = [];
  for (const page of pages || []) {
    const words = (page.words || []).filter((w) => w.bbox && w.text);
    const sorted = [...words].sort((a, b) => {
      const ay = (a.bbox.y0 + a.bbox.y1) / 2;
      const by = (b.bbox.y0 + b.bbox.y1) / 2;
      if (Math.abs(ay - by) > 8) {
        return ay - by;
      }
      return a.bbox.x0 - b.bbox.x0;
    });

    let current = [];
    let currentY = null;
    for (const word of sorted) {
      const y = (word.bbox.y0 + word.bbox.y1) / 2;
      if (currentY === null || Math.abs(y - currentY) <= 10) {
        current.push(word);
        currentY = currentY === null ? y : (currentY + y) / 2;
      } else {
        if (current.length) {
          lines.push(current.map((w) => w.text).join(" "));
        }
        current = [word];
        currentY = y;
      }
    }
    if (current.length) {
      lines.push(current.map((w) => w.text).join(" "));
    }
  }
  return lines.map((l) => normalizeOcrForId(l));
}

function findValueNearField(lines, normalizedText, labels, valueType) {
  const lowerLines = (lines || []).map((line) => line.toLowerCase());
  const normalizedLabels = labels.map((l) => normalizeOcrForId(l).toLowerCase());

  for (let i = 0; i < lowerLines.length; i += 1) {
    for (const label of normalizedLabels) {
      if (!lowerLines[i].includes(label)) {
        continue;
      }
      const same = extractValueFromLine(lines[i], valueType, label);
      if (same) {
        return same;
      }
      if (i + 1 < lines.length) {
        const next = extractValueFromLine(lines[i + 1], valueType, "");
        if (next) {
          return next;
        }
      }
    }
  }

  for (const label of normalizedLabels) {
    const blockRegex = new RegExp(`${escapeRegExp(label)}[\\s:\\-]{0,12}([^\\n]{0,40})`, "i");
    const match = normalizedText.match(blockRegex);
    if (match) {
      const extracted = extractValueFromLine(match[1], valueType, "");
      if (extracted) {
        return extracted;
      }
    }
  }
  return "";
}

function extractValueFromLine(line, valueType, label) {
  if (!line) {
    return "";
  }
  let segment = line;
  if (label && line.toLowerCase().includes(label.toLowerCase())) {
    const idx = line.toLowerCase().indexOf(label.toLowerCase());
    segment = line.slice(idx + label.length);
  }

  if (valueType === "date") {
    const m = segment.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/);
    return m ? m[0] : "";
  }
  if (valueType === "sex") {
    const m = segment.match(/\b(male|female|m|f|x)\b/i);
    return m ? m[0] : "";
  }
  if (valueType === "height") {
    const m = segment.match(/\b\d{1,2}['’` ]\d{1,2}["”]?\b|\b\d{2,3}\s?(cm|in)\b/i);
    return m ? m[0] : "";
  }
  if (valueType === "weight") {
    const m = segment.match(/\b\d{2,3}\s?(lb|lbs|kg)?\b/i);
    return m ? m[0] : "";
  }
  if (valueType === "alpha") {
    const m = segment.match(/\b[A-Za-z]{3,8}\b/);
    return m ? m[0] : "";
  }
  return "";
}

function parseDateText(value) {
  if (!value) {
    return null;
  }
  const parsed = extractDates(normalizeOcrForId(value));
  return parsed.length ? parsed[0] : null;
}

function extractHeight(text) {
  const patterns = [
    /\b(?:height|hgt|ht)\s*[:\-]?\s*(\d{1,2})['’` ]\s*(\d{1,2})["”]?\b/i,
    /\b(?:height|hgt|ht)\s*[:\-]?\s*(\d{2,3})\s*(cm|in)\b/i,
    /\b(\d{1,2})['’` ]\s*(\d{1,2})["”]\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }

    if (match[2] && /cm|in/i.test(match[2])) {
      const value = Number(match[1]);
      const unit = match[2].toLowerCase();
      return { raw: match[0], value, unit };
    }

    const feet = Number(match[1]);
    const inches = Number(match[2]);
    if (Number.isFinite(feet) && Number.isFinite(inches)) {
      return { raw: match[0], value: feet * 12 + inches, unit: "in" };
    }
  }

  return null;
}

function extractWeight(text) {
  const match = text.match(/\b(?:weight|wgt|wt)\s*[:\-]?\s*(\d{2,3})\s*(lb|lbs|kg)?\b/i);
  if (!match) {
    return null;
  }

  return {
    raw: match[0],
    value: Number(match[1]),
    unit: (match[2] || "lb").toLowerCase(),
  };
}

function isPlausibleHeight(height) {
  if (!height) {
    return true;
  }
  if (height.unit === "cm") {
    return height.value >= 120 && height.value <= 230;
  }
  // inches
  return height.value >= 48 && height.value <= 90;
}

function isPlausibleWeight(weight) {
  if (!weight) {
    return true;
  }
  if (weight.unit === "kg") {
    return weight.value >= 35 && weight.value <= 220;
  }
  // pounds
  return weight.value >= 80 && weight.value <= 500;
}

function buildUtcDate(year, month, day) {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

function findDateNearKeywords(dates, text, keywords) {
  if (!dates.length) {
    return null;
  }
  const lower = text.toLowerCase();
  for (const keyword of keywords) {
    const idx = lower.indexOf(keyword.toLowerCase());
    if (idx === -1) {
      continue;
    }
    const window = text.slice(idx, idx + 80);
    const match = window.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/);
    if (match) {
      const parsed = extractDates(match[0])[0];
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

function formatDateIso(date) {
  return date.toISOString().slice(0, 10);
}

function calculateAge(dob, now) {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

function collectPatternClues(text, patterns, type) {
  const clues = [];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern.regex)].slice(0, 20);
    for (const match of matches) {
      clues.push({
        type,
        title: pattern.clue,
        snippet: match[0],
        rawMatch: match[0],
        weight: pattern.weight,
      });
    }
  }
  return clues;
}

function getMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function renderReport(report) {
  resultsCard.classList.remove("hidden");
  riskScoreEl.textContent = String(report.riskScore);
  riskScoreEl.style.color = getRiskColor(report.riskScore);
  totalFlagsEl.textContent = String(report.totalFlags);
  textLengthEl.textContent = String(report.textLength);
  renderAnalysisSummary(report.summary);
  renderDetectionConfidence(report.detectionConfidence);

  if (!report.clues.length) {
    issuesList.innerHTML =
      '<p class="empty">No strong edit clues were detected in extracted text. Manual review is still recommended.</p>';
    renderDocumentPreview(report.pages);
    return;
  }

  const items = report.clues
    .map((clue, idx) => {
      const numericClass = clue.type === "Numeric anomaly" ? "issue--numeric" : "";
      return `
        <article class="issue ${numericClass}">
          <div class="issue-title">
            <span class="chip">${escapeHtml(clue.type)}</span>Flag #${idx + 1}
          </div>
          <p class="issue-meta">${escapeHtml(clue.title)}</p>
          <p class="line"><strong>Match:</strong> ${escapeHtml(clue.snippet || "(empty)")}</p>
        </article>
      `;
    })
    .join("");

  issuesList.innerHTML = items;
  renderDocumentPreview(report.pages);
}

function renderAnalysisSummary(summary) {
  if (!summary || !summary.items || !summary.items.length) {
    analysisSummaryEl.innerHTML = '<p class="empty">No summary data detected.</p>';
    return;
  }

  const html = summary.items
    .map(
      (item) =>
        `<div class="summary-item"><span class="summary-key">${escapeHtml(item.key)}:</span>${escapeHtml(
          item.value
        )}</div>`
    )
    .join("");

  analysisSummaryEl.innerHTML = `<div class="summary-grid">${html}</div>`;
}

function renderDetectionConfidence(data) {
  if (!detectionConfidenceEl) {
    return;
  }
  if (!data) {
    detectionConfidenceEl.value = "Unknown";
    return;
  }
  detectionConfidenceEl.value = `${data.level} (${data.score}%)`;
}

function buildAnalysisSummary(extracted, profile) {
  const text = extracted.text;
  const items = [];
  items.push({ key: "Detected type", value: getDetectedTypeLabel(profile) });

  if (profile.likelyId) {
    const idFields = extractIdCoreFields(text, extracted.pages);
    items.push({ key: "DOB", value: idFields.dob ? formatDateIso(idFields.dob) : "Not found" });
    items.push({ key: "Expiration", value: idFields.expiry ? formatDateIso(idFields.expiry) : "Not found" });
    items.push({ key: "Issue date", value: idFields.issueDate ? formatDateIso(idFields.issueDate) : "Not found" });
    items.push({ key: "Sex", value: idFields.sex || "Not found" });
    items.push({ key: "Height", value: idFields.height ? idFields.height.raw : "Not found" });
    items.push({ key: "Weight", value: idFields.weight ? idFields.weight.raw : "Not found" });
    items.push({ key: "Eyes", value: idFields.eyes || "Not found" });
    items.push({ key: "Hair", value: idFields.hair || "Not found" });
    return { items, idFields };
  }

  if (profile.likelyBankStatement) {
    items.push({
      key: "Opening balance",
      value: formatSummaryMoney(getPrimaryAmountByKeywords(text, ["beginning balance", "opening balance", "starting balance"])),
    });
    items.push({
      key: "Deposits/credits",
      value: formatSummaryMoney(getPrimaryAmountByKeywords(text, ["total deposits", "credits", "total credits", "deposits"])),
    });
    items.push({
      key: "Withdrawals/debits",
      value: formatSummaryMoney(getPrimaryAmountByKeywords(text, ["total withdrawals", "debits", "total debits", "withdrawals"])),
    });
    items.push({
      key: "Ending balance",
      value: formatSummaryMoney(getPrimaryAmountByKeywords(text, ["ending balance", "closing balance", "new balance"])),
    });
  } else if (profile.likelyPayStub) {
    items.push({ key: "Gross pay", value: formatSummaryMoney(getPrimaryAmountByKeywords(text, ["gross pay", "current gross"])) });
    items.push({ key: "Deductions", value: formatSummaryMoney(getPrimaryAmountByKeywords(text, ["total deductions", "deductions"])) });
    items.push({ key: "Net pay", value: formatSummaryMoney(getPrimaryAmountByKeywords(text, ["net pay", "take home pay"])) });
    items.push({
      key: "YTD gross",
      value: formatSummaryMoney(getPrimaryAmountByKeywords(text, ["ytd gross", "gross ytd", "year to date gross"])),
    });
  }

  return { items, idFields: null };
}

function getDetectedTypeLabel(profile) {
  if (profile.likelyId) {
    return "Driver license / ID";
  }
  if (profile.likelyBankStatement) {
    return "Bank statement";
  }
  if (profile.likelyPayStub) {
    return "Pay stub";
  }
  return "Unknown";
}

function formatSummaryMoney(value) {
  if (!Number.isFinite(value)) {
    return "Not found";
  }
  return `$${Number(value).toFixed(2)}`;
}

function getRiskColor(score) {
  const bounded = Math.max(0, Math.min(100, score));
  const hue = 120 - (bounded * 120) / 100;
  return `hsl(${hue.toFixed(0)} 78% 42%)`;
}

function computeDetectionConfidence(extracted, profile, summary, scanMode) {
  const textLength = extracted?.text?.length || 0;
  const pages = extracted?.pages?.length || 0;
  const ocrDensity = pages > 0 ? textLength / pages : textLength;
  let score = 45;

  if (ocrDensity > 1000) score += 15;
  else if (ocrDensity > 500) score += 10;
  else if (ocrDensity < 250) score -= 10;

  const profileScores = [profile.bankScore || 0, profile.payStubScore || 0, profile.idScore || 0].sort((a, b) => b - a);
  const separation = (profileScores[0] || 0) - (profileScores[1] || 0);
  if (separation >= 3) score += 15;
  else if (separation <= 1) score -= 10;

  if (summary?.idFields) {
    const idCompleteness =
      Number(Boolean(summary.idFields.dob)) +
      Number(Boolean(summary.idFields.expiry)) +
      Number(Boolean(summary.idFields.sex)) +
      Number(Boolean(summary.idFields.height)) +
      Number(Boolean(summary.idFields.weight));
    score += idCompleteness * 3;
  }

  if (scanMode === "forensic") {
    score += 8;
  }

  score = Math.max(5, Math.min(99, Math.round(score)));
  let level = "Low";
  if (score >= 80) level = "High";
  else if (score >= 60) level = "Medium";

  return { score, level };
}

function attachHighlights(report, pages) {
  const pageHighlights = pages.map((page) => ({
    ...page,
    highlights: [],
  }));

  for (const clue of report.clues) {
    if (!clue.rawMatch) {
      continue;
    }

    for (let pageIndex = 0; pageIndex < pageHighlights.length; pageIndex += 1) {
      const matches = findWordBoxesForSnippet(pageHighlights[pageIndex].words, clue.rawMatch);
      if (!matches.length) {
        continue;
      }

      for (const box of matches.slice(0, 3)) {
        pageHighlights[pageIndex].highlights.push({
          clueId: clue.id,
          box,
        });
      }
      break;
    }
  }

  return {
    ...report,
    pages: pageHighlights,
  };
}

function findWordBoxesForSnippet(words, snippet) {
  const needleTokens = splitForMatching(snippet);
  if (!needleTokens.length) {
    return [];
  }

  const results = [];
  const wordTokens = words.map((word) => splitForMatching(word.text).join(""));
  const compactNeedle = needleTokens.join("");

  for (let i = 0; i < words.length; i += 1) {
    if (!wordTokens[i]) {
      continue;
    }

    if (!wordTokens[i].includes(compactNeedle) && compactNeedle.length > 2) {
      let combined = wordTokens[i];
      let end = i;
      while (combined.length < compactNeedle.length + 8 && end + 1 < words.length) {
        end += 1;
        combined += wordTokens[end];
        if (combined.includes(compactNeedle)) {
          const box = mergeBoxes(words.slice(i, end + 1).map((w) => w.bbox));
          if (box) {
            results.push(box);
          }
          break;
        }
      }
    } else {
      const box = mergeBoxes([words[i].bbox]);
      if (box) {
        results.push(box);
      }
    }
  }

  return results;
}

function splitForMatching(value) {
  return (value.toLowerCase().match(/[a-z0-9]+/g) || []).map((v) => v.trim()).filter(Boolean);
}

function mergeBoxes(boxes) {
  const valid = boxes.filter(Boolean);
  if (!valid.length) {
    return null;
  }
  const x0 = Math.min(...valid.map((b) => b.x0));
  const y0 = Math.min(...valid.map((b) => b.y0));
  const x1 = Math.max(...valid.map((b) => b.x1));
  const y1 = Math.max(...valid.map((b) => b.y1));
  return { x0, y0, x1, y1 };
}

function renderDocumentPreview(pages) {
  if (!pages.length) {
    documentPreviewEl.innerHTML = '<p class="empty">No page preview available.</p>';
    return;
  }

  const markup = pages
    .map((page) => {
      const boxes = page.highlights
        .map((h) => {
          const left = ((h.box.x0 / page.width) * 100).toFixed(2);
          const top = ((h.box.y0 / page.height) * 100).toFixed(2);
          const width = (((h.box.x1 - h.box.x0) / page.width) * 100).toFixed(2);
          const height = (((h.box.y1 - h.box.y0) / page.height) * 100).toFixed(2);
          return `<div class="highlight-box" title="Flag #${h.clueId}" style="left:${left}%; top:${top}%; width:${width}%; height:${height}%;"></div>`;
        })
        .join("");

      return `
        <article class="preview-page">
          <p class="preview-title">Page ${page.pageNumber} (${page.highlights.length} highlights)</p>
          <div class="preview-canvas-wrap">
            <img class="preview-image" src="${page.imageUrl}" alt="Document page ${page.pageNumber}" />
            ${boxes}
          </div>
        </article>
      `;
    })
    .join("");

  documentPreviewEl.innerHTML = markup;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
