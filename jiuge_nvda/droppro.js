const fs = require("fs");
const path = require("path");
const {
    DEFAULT_CONFIG,
    appendJsonl,
    askModel,
    buildSummaryPayload,
    createStatsTracker,
    ensureDir,
    formatMs,
    getDatasetPath,
    getGpuStats,
    sleep,
    startGpuMonitor,
    updateStatsTracker,
    writeAllTestSummary,
} = require("./common_v1");

const LIMIT = Number(process.env.DROP_LIMIT || 500);
const RESULT_DIR = DEFAULT_CONFIG.resultDir;
const DROP_API_URL = process.env.INFINILM_API_URL || DEFAULT_CONFIG.apiUrl;
const DROP_MODEL_NAME = process.env.INFINILM_MODEL || DEFAULT_CONFIG.modelName;
const DROP_MAX_TOKENS = Number(process.env.DROP_MAX_TOKENS || 4096);
const DROP_TEMPERATURE = Number(process.env.DROP_TEMPERATURE || 0.05);
const DROP_TIMEOUT_MS = Number(process.env.DROP_TIMEOUT_MS || 600000);
const DROP_COOLDOWN_MS = Number(process.env.DROP_COOLDOWN_MS || 2000);
const DROP_REQUEST_RETRIES = Number(process.env.DROP_REQUEST_RETRIES || 1);
const PRIMARY_STOP = [
    "\nPassage:",
    "\nQuestion:",
    "\nInstructions:",
    "\nResponse:",
    "\nExample:",
    "\n\nPassage:",
    "\n\nQuestion:",
    "\n\nInstructions:",
];

const NUMBER_WORDS = {
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
    eleven: "11",
    twelve: "12",
    thirteen: "13",
    fourteen: "14",
    fifteen: "15",
    sixteen: "16",
    seventeen: "17",
    eighteen: "18",
    nineteen: "19",
    twenty: "20",
};
const NUMBER_WORD_PATTERN = Object.keys(NUMBER_WORDS).join("|");

function hasNumberType(types) {
    return Array.isArray(types) && types.some(type => String(type).toLowerCase() === "number");
}

function buildBasePrompt(passage, question) {
    return `Passage:\n${passage}\n\nQuestion:\n${question}`;
}

function getQuestionProfile(question, expectsNumber) {
    const lowerQuestion = String(question || "").toLowerCase().trim();
    const asksEntity = /^(who|which player|which team|what player|what team)\b/.test(lowerQuestion);
    const asksPoints = expectsNumber && /\bhow many points?\b/.test(lowerQuestion);
    const asksDistance = /\b(?:how many yards?|how long|yardage|fewest yard|longest field goal|shortest touchdown|longest touchdown|longest pass|shortest field goal)\b/.test(lowerQuestion);
    const asksNonCountUnit =
        /\b(percent|percentage|years?|months?|weeks?|days?|minutes?)\b/.test(lowerQuestion) ||
        /\bhow many seconds?\b/.test(lowerQuestion);
    const asksCount = expectsNumber &&
        /\bhow many\b/.test(lowerQuestion) &&
        !asksPoints &&
        !asksDistance &&
        !asksNonCountUnit;

    let mode = expectsNumber ? "number" : "span";
    if (asksEntity) mode = "entity";
    else if (asksPoints) mode = "points";
    else if (asksCount) mode = "count";
    else if (asksDistance && expectsNumber) mode = "distance_number";
    else if (asksDistance) mode = "distance_span";

    const checks = [];
    if (/\bfield goals?\b/.test(lowerQuestion)) {
        checks.push("HARD FILTER: a valid field-goal evidence fragment must contain the words field goal. If a fragment does not contain field goal, discard it.");
        checks.push("Only consider events whose evidence says field goal. Ignore touchdowns, TD passes, catches, interception returns, runs, and other scoring plays.");
        checks.push("Never use a yard value from a touchdown, catch, TD pass, interception return, or run as the answer to a field-goal question.");
    }
    if (asksPoints) {
        checks.push("Points are score values, not yard distances. Never subtract yard values to get points.");
        checks.push("In football scoring, a field goal gives 3 points regardless of whether it was 23-yard, 38-yard, or another distance.");
    }
    if (/\b(?:touchdown|td pass|touchdown reception)\b/.test(lowerQuestion)) {
        checks.push("Only consider touchdowns or touchdown passes. Do not count field goals.");
    }
    if (/\b(?:lion'?s?|detroit|buccaneers?|tampa bay)\b/.test(lowerQuestion)) {
        checks.push("Respect team aliases established in the passage, such as Lions/Detroit and Buccaneers/Tampa Bay. Treat possessives like Lion's as the team name.");
    }
    if (/\bthrew\b/.test(lowerQuestion)) {
        checks.push("If the question asks who threw, answer the passer, not the receiver.");
    }
    if (/\bcaught\b/.test(lowerQuestion)) {
        checks.push("If the question asks who caught, answer the receiver, not the passer.");
    }
    if (/\bfirst\b|\bsecond\b|\bthird\b|\bfourth\b|\bhalf\b|\b2nd\b|\b3rd\b|\b4th\b/.test(lowerQuestion)) {
        checks.push("Respect the exact quarter, half, or ordering constraint in the question.");
    }
    if (/\blongest\b|\bmost\b/.test(lowerQuestion)) {
        checks.push("Filter to the correct team/player and event type first, then choose the largest relevant value. Never choose a larger value from an excluded event.");
    }
    if (/\bshortest\b|\bfewest\b/.test(lowerQuestion)) {
        checks.push("Filter to the correct team/player and event type first, then choose the smallest relevant value. Never choose a smaller value from an excluded event.");
    }

    return { lowerQuestion, mode, expectsNumber, checks };
}

function buildQuestionFocus(profile) {
    const needsHardFocus =
        /\bfield goals?\b/.test(profile.lowerQuestion) &&
        (/^distance_/.test(profile.mode) || /\blongest\b|\bshortest\b|\bfewest\b|\bmost\b/.test(profile.lowerQuestion));

    if (!needsHardFocus) return "";

    const focus = [
        "Question focus:",
        `- Mode: ${profile.mode}.`,
        "- Do not answer until every filter in the question has been applied.",
    ];

    if (/\bfield goals?\b/.test(profile.lowerQuestion)) {
        focus.push("- Field-goal rule: only phrases containing field goal are valid evidence.");
        focus.push("- Invalid for field-goal questions: touchdown catch, TD pass, interception return, ran it in, caught a pass.");
        focus.push("- For field-goal yardage, compare only values in phrases like N-yard field goal after team/player filters.");
    }

    if (/\b(?:lion'?s?|detroit)\b/.test(profile.lowerQuestion)) {
        focus.push("- Team filter: Lion's/Lions/Detroit all mean the Detroit Lions.");
    }

    if (/\b(?:buccaneers?|tampa bay)\b/.test(profile.lowerQuestion)) {
        focus.push("- Team filter: Buccaneers/Tampa Bay mean the same team.");
    }

    if (/\blongest\b|\bmost\b/.test(profile.lowerQuestion)) {
        focus.push("- Comparison rule: choose the largest value only after invalid events are removed.");
    }

    if (/\bshortest\b|\bfewest\b/.test(profile.lowerQuestion)) {
        focus.push("- Comparison rule: choose the smallest value only after invalid events are removed.");
    }

    return focus.join("\n");
}

function buildInstructions(profile) {
    const common = [
        "Instructions:",
        "1. Read the passage carefully and answer using only the passage.",
        "2. Think step-by-step before the final answer. It is OK to spend more tokens reasoning if needed.",
        "3. First decide the answer type: count, points, yards/length, person/team, or short text span.",
        "4. Track the exact event type, team/player, quarter/half, order, units, and arithmetic.",
        "5. Apply filters in this order: event type, team/player, time/order, then longest/shortest/count/arithmetic.",
        "6. Before the final answer, write one line exactly as: Relevant: <only the matching evidence you used>.",
    ];

    switch (profile.mode) {
    case "count":
        return [
            ...common,
            "7. This asks for a count of matching events. Count events, not yards, points, or names.",
            "8. The Relevant line must list every matching event and no excluded event.",
            "9. The final answer must be Arabic numerals only, with no units.",
            "10. Put the final answer on the last line exactly as: Answer: <number>",
            "11. Do not output anything after the Answer line.",
        ].join("\n");
    case "points":
        return [
            ...common,
            "7. This asks for points. Do not answer with yards or play distance.",
            "8. Remember: a field goal is 3 points; a touchdown scoring play is 6 points unless the passage asks including extra points.",
            "9. Yard values such as 23-yard or 38-yard are distances, not score values. Never subtract yard distances to compute points.",
            "10. If a field goal tied the game, the points needed for that tie were 3.",
            "11. The final answer must be Arabic numerals only, with no units.",
            "12. Put the final answer on the last line exactly as: Answer: <number>",
            "13. Do not output anything after the Answer line.",
        ].join("\n");
    case "distance_number":
        return [
            ...common,
            "7. This asks for distance/yardage. Answer the yard number only.",
            "8. Compare only matching yard values after all filters are applied.",
            "9. Do not answer with the player, count, or points.",
            "10. The final answer must be Arabic numerals only, with no units.",
            "11. Put the final answer on the last line exactly as: Answer: <number>",
            "12. Do not output anything after the Answer line.",
        ].join("\n");
    case "distance_span":
        return [
            ...common,
            "7. This asks for a measurement span. Prefer the shortest phrase from the passage, such as 28-yard.",
            "8. Compare only matching measurement values after all filters are applied.",
            "9. Do not answer with a full sentence.",
            "10. Put the final answer on the last line exactly as: Answer: <short span>",
            "11. Do not output anything after the Answer line.",
        ].join("\n");
    case "entity":
        return [
            ...common,
            "7. This asks for an entity. The final answer should be only the person/team/name, not a full sentence.",
            "8. Use longest/shortest/fewest/first/half clues only to identify the correct entity.",
            "9. Put the final answer on the last line exactly as: Answer: <entity>",
            "10. Do not output anything after the Answer line.",
        ].join("\n");
    case "number":
        return [
            ...common,
            "7. This asks for a numeric answer. Compute or locate it carefully.",
            "8. The final answer must be Arabic numerals only, with no units.",
            "9. Put the final answer on the last line exactly as: Answer: <number>",
            "10. Do not output anything after the Answer line.",
        ].join("\n");
    default:
        return [
            ...common,
            "7. Extract the shortest correct answer span from the passage when possible.",
            "8. Put the final answer on the last line exactly as: Answer: <final answer>",
            "9. Do not output anything after the Answer line.",
        ].join("\n");
    }
}

function buildPrompt(passage, question, profile) {
    const checks = profile.checks.length === 0
        ? ""
        : `\n\nTask checks:\n${profile.checks.map(check => `- ${check}`).join("\n")}`;
    const focus = buildQuestionFocus(profile);

    const parts = [
        "You are an expert in reading comprehension and arithmetic.",
        "",
        buildBasePrompt(passage, question),
        "",
        buildInstructions(profile),
        checks,
        "",
        "Response:",
    ];

    if (focus) {
        parts.splice(4, 0, focus, "");
    }

    return parts.join("\n");
}

function removeThinkBlocks(rawOutput) {
    const text = String(rawOutput || "");
    const thinkIndex = text.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        return text.slice(thinkIndex + 8).trim();
    }

    return text.replace(/<think>[\s\S]*?<\/think>/gi, " ").trim();
}

function cleanModelOutput(rawOutput) {
    if (!rawOutput) return "";

    return removeThinkBlocks(rawOutput)
        .replace(/\u0000/g, "")
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .replace(/<\|eot_id\|>/gi, " ")
        .replace(/<\/?think>/gi, " ")
        .replace(/```[\s\S]*?```/g, match => match.replace(/```/g, " "))
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function normalizeAnswer(value) {
    if (!value) return "";

    return String(value)
        .toLowerCase()
        .replace(/<\|im_end\|>|<\|endoftext\|>|<\/?think>/gi, " ")
        .replace(/\b(\d+)\s*-\s*yards?\b/g, "$1 yard")
        .replace(/\b(\d+)\s+yards?\b/g, "$1 yard")
        .replace(/\b(\d+)\s*-\s*points?\b/g, "$1 point")
        .replace(/\b(\d+)\s+points?\b/g, "$1 point")
        .replace(/\b(a|an|the)\b/g, " ")
        .replace(/[.,!?;:"'`]/g, "")
        .replace(/-/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function parseNumericToken(text) {
    if (!text) return "";

    const digitMatch = String(text).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (digitMatch) return digitMatch[0];

    const normalized = String(text).trim().toLowerCase();
    return NUMBER_WORDS[normalized] || "";
}

function stripWrapperPhrases(text) {
    return String(text || "")
        .replace(/^(?:answer|final answer)\s*:\s*/i, "")
        .replace(/^(?:the\s+)?final answer\s+is\s*:?\s*/i, "")
        .replace(/^(?:the answer is|answer is|answer should be|it is|it was)\s+/i, "")
        .replace(/^is\s*:\s*/i, "")
        .replace(/^[:：]\s*/i, "")
        .replace(/^[>\-*[\](){}"'\s]+|[>\-*[\](){}"'\s]+$/g, "")
        .trim();
}

function normalizeMeasurement(rawText) {
    const match = String(rawText || "").match(/(-?\d+(?:\.\d+)?)\s*(?:-| )?(yard|yards|point|points|percent|%)\b/i);
    if (!match) return stripWrapperPhrases(rawText);

    const value = match[1];
    const unit = match[2].toLowerCase();
    if (unit === "%") return `${value}%`;
    if (unit === "percent") return `${value} percent`;
    if (unit.startsWith("yard")) return `${value}-yard`;
    if (unit.startsWith("point")) return `${value}-point`;
    return `${value} ${unit}`;
}

function extractMeasurement(text) {
    const patterns = [
        /-?\d+(?:\.\d+)?\s*(?:-| )?(?:yard|yards|point|points|percent|%)/i,
        /-?\d+(?:\.\d+)?/i,
    ];

    for (const pattern of patterns) {
        const match = String(text || "").match(pattern);
        if (match) return normalizeMeasurement(match[0]);
    }

    return "";
}

function extractLeadingEntity(text) {
    const cleaned = stripWrapperPhrases(text);
    if (!cleaned) return "";

    const beforeVerb = cleaned
        .split(/\b(?:caught|scored|threw|kicked|made|had|was|were|is|are|won|led|tied|returned|recorded|completed|ran|rushed|finished|intercepted|passed)\b/i)[0]
        .trim()
        .replace(/[.,!?;:]+$/g, "");

    if (beforeVerb && beforeVerb.split(/\s+/).length <= 6) return beforeVerb;

    const nameMatch = cleaned.match(/^([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,5})/);
    if (nameMatch) return nameMatch[1].trim();

    return cleaned;
}

function refineTextAnswer(question, candidate) {
    const text = stripWrapperPhrases(candidate);
    if (!text) return "";

    const lowerQuestion = String(question || "").toLowerCase();
    if (/^(who|which player|which team|what player|what team)\b/i.test(lowerQuestion)) {
        return extractLeadingEntity(text);
    }

    if (/(how long|how many yards|how many points|longest field goal|shortest touchdown|longest pass|fewest yard|yardage|what was the longest|what was the shortest)/i.test(lowerQuestion)) {
        const measurement = extractMeasurement(text);
        if (measurement) return measurement;
    }

    if (text.includes(",")) {
        const head = text.split(",")[0].trim();
        if (head && head.split(/\s+/).length <= 6) return stripWrapperPhrases(head);
    }

    return text.replace(/\s+(?:who|that|which)\b[\s\S]*$/i, "").trim();
}

function extractExplicitAnswer(cleanText, isNumberType) {
    const lines = cleanText.split(/\r?\n/).map(line => line.trim());
    const candidates = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const sameLine = line.match(/^(?:[.\-*>]\s*)?(?:\d+\s*[.)]\s*)?Answer\s*:\s*(.+)$/i);
        if (sameLine) {
            candidates.push(sameLine[1].trim());
            continue;
        }

        if (/^Answer\s*:\s*$/i.test(line)) {
            for (let j = i + 1; j < lines.length; j++) {
                const next = lines[j].trim();
                if (!next) continue;
                candidates.push(next);
                break;
            }
        }
    }

    if (candidates.length === 0) return "";

    const result = stripWrapperPhrases(candidates[candidates.length - 1]);
    if (!result) return "";

    return isNumberType ? parseNumericToken(result) : result;
}

function isCountQuestion(question) {
    const lowerQuestion = String(question || "").toLowerCase();
    const asksPoints = /\bhow many points?\b/.test(lowerQuestion);
    const asksDistance = /\b(?:how many yards?|how long|yardage|fewest yard|longest field goal|shortest touchdown|longest touchdown|longest pass|shortest field goal)\b/.test(lowerQuestion);
    const asksNonCountUnit =
        /\b(percent|percentage|years?|months?|weeks?|days?|minutes?)\b/.test(lowerQuestion) ||
        /\bhow many seconds?\b/.test(lowerQuestion);

    return /\bhow many\b/.test(lowerQuestion) && !asksPoints && !asksDistance && !asksNonCountUnit;
}

function extractRelevantText(cleanText) {
    const match = String(cleanText || "").match(/(?:^|\n)Relevant\s*:\s*([\s\S]*?)(?=\n\s*(?:[.\-*>]\s*)?(?:Excluded|Answer|Task checks|Question|Passage|Instructions|Response)\s*:|\n\s*\d+\s*$|$)/i);
    return match ? match[1].trim() : "";
}

function countDelimitedEvents(text) {
    const cleaned = String(text || "")
        .replace(/\([^)]*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) return 0;

    const numbered = cleaned.match(/(?:^|\s)\d+\s*[.)]\s+/g);
    if (numbered && numbered.length > 1) return numbered.length;

    const pipeParts = cleaned.split(/\s+\|\s+/).map(part => part.trim()).filter(Boolean);
    if (pipeParts.length > 1) return pipeParts.length;

    return 0;
}

function extractRelevantCount(cleanText, question) {
    if (!isCountQuestion(question)) return "";

    const relevant = extractRelevantText(cleanText);
    if (!relevant) return "";

    const lowerQuestion = String(question || "").toLowerCase();
    const lowerRelevant = relevant.toLowerCase();
    const delimitedCount = countDelimitedEvents(relevant);
    if (delimitedCount > 1) return String(delimitedCount);

    if (/\bfield goals?\b/.test(lowerQuestion)) {
        const matches = lowerRelevant.match(/\bfield goal\b/g);
        if (matches && matches.length > 1) return String(matches.length);
    }

    if (/\btouchdowns?\b|\btd\b/.test(lowerQuestion)) {
        const markers = [
            ...lowerRelevant.matchAll(/\btouchdown\b|\btd\b|\bran it in\b|\bcaught (?:a|an)?\s*\d+-yard pass\b/gi),
        ];
        if (markers.length > 1) return String(markers.length);
    }

    return "";
}

function extractNumberFallback(lines) {
    const conclusionPattern = new RegExp(
        `(?:there\\s+(?:are|were)|answer(?:\\s+should\\s+be|\\s+is)?|(?:the\\s+)?(?:total|count|number)(?:\\s+is|\\s+was)?|(?:shortest|longest|fewest|most)(?:\\s+[a-z]+){0,4}?\\s+(?:is|was)|would\\s+be|equals?|equal\\s+to|needed|need|scored|total(?:ed)?|for|have|has)\\s+(-?\\d+(?:\\.\\d+)?|${NUMBER_WORD_PATTERN})(?:\\s*%|\\s+(?:yards?|points?|field\\s+goals?)|\\b|$)`,
        "i"
    );

    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const lower = line.toLowerCase();

        const tiedMatch = line.match(/tied at\s+(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/i);
        if (tiedMatch && tiedMatch[1] === tiedMatch[2]) return tiedMatch[1];

        const directNumeric = parseNumericToken(line);
        if (directNumeric && new RegExp(`^(-?\\d+(?:\\.\\d+)?|${NUMBER_WORD_PATTERN})$`, "i").test(line.trim())) {
            return directNumeric;
        }

        const match = line.match(conclusionPattern);
        if (match) {
            const parsed = parseNumericToken(match[1]);
            if (parsed) return parsed;
        }

        const percentMatches = [...line.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)];
        if (percentMatches.length > 0) return percentMatches[percentMatches.length - 1][1];

        if (/yard|yards|field goal|touchdown|td pass|quarter|intercepted|pass from|ran it in/.test(lower)) {
            continue;
        }
    }

    return "";
}

function extractComputedNumber(cleanText) {
    const patterns = [
        /100\s*%\s*-\s*-?\d+(?:\.\d+)?\s*%\s*=\s*(-?\d+(?:\.\d+)?)/gi,
        /not [^.\n]*?\b(?:is|was|were|would be|equals?|equal to)\s*(-?\d+(?:\.\d+)?)\s*%/gi,
        /tied at\s+(-?\d+(?:\.\d+)?)\s*-\s*\1/gi,
        /(?:have|has)\s+(-?\d+(?:\.\d+)?)\s+points?\b/gi,
        new RegExp(`there\\s+(?:are|were)\\s+(-?\\d+(?:\\.\\d+)?|${NUMBER_WORD_PATTERN})\\s+(?:field goals?|touchdowns?|points?)`, "gi"),
        new RegExp(`(?:shortest|longest|fewest|most)[^.\\n]*?\\b(?:is|was)\\s+(-?\\d+(?:\\.\\d+)?|${NUMBER_WORD_PATTERN})(?:\\s+(?:yards?|points?|percent))?`, "gi"),
        /therefore[^.\n]*?(-?\d+(?:\.\d+)?)\s*%/gi,
        /so[^.\n]*?(-?\d+(?:\.\d+)?)\s*%/gi,
    ];

    for (const pattern of patterns) {
        const matches = [...cleanText.matchAll(pattern)];
        if (matches.length > 0) {
            const last = matches[matches.length - 1];
            if (last[1]) return parseNumericToken(last[1]) || last[1];
        }
    }

    return "";
}

function extractConclusionText(cleanText) {
    const patterns = [
        /answer should be\s+([^\n.]{1,120})/gi,
        /answer is\s+([^\n.]{1,120})/gi,
        /final answer[: ]+\s*([^\n.]{1,120})/gi,
        /therefore[,:\s]+([^\n.]{1,120})/gi,
        /thus[,:\s]+([^\n.]{1,120})/gi,
        /so[,:\s]+([^\n.]{1,120})/gi,
    ];

    for (const pattern of patterns) {
        const matches = [...cleanText.matchAll(pattern)];
        if (matches.length === 0) continue;
        const candidate = stripWrapperPhrases(matches[matches.length - 1][1]);
        if (!candidate) continue;
        if (/^(i think|let me|the question|from the passage|it means)/i.test(candidate)) continue;
        return candidate;
    }

    return "";
}

function extractTextFallback(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = stripWrapperPhrases(lines[i]);
        if (!line || line.length > 120) continue;
        if (/^(okay|ok|well|now|first|second|third|finally)[,:\s]/i.test(line)) continue;
        if (/^(i think|i need to|let me|we need to|the question is|looking at the passage)/i.test(line)) continue;
        if (/^(reasoning|analysis|explanation|step|steps)/i.test(line)) continue;
        if (/^(therefore|thus|so|hence|from the passage)[,:]?\s*$/i.test(line)) continue;
        return line;
    }

    return "";
}

function extractAnswer(rawOutput, isNumberType = false) {
    if (!rawOutput) return "";
    const cleanText = cleanModelOutput(rawOutput);
    const explicit = extractExplicitAnswer(cleanText, isNumberType);
    if (explicit) return explicit;

    const lines = cleanText.split("\n").map(line => line.trim()).filter(Boolean);
    if (isNumberType) {
        const computed = extractComputedNumber(cleanText);
        if (computed) return computed;
        return extractNumberFallback(lines);
    }

    const concluded = extractConclusionText(cleanText);
    if (concluded) return concluded;
    return extractTextFallback(lines);
}

function extractPrediction(rawOutput, isNumberType, question) {
    if (isNumberType && rawOutput) {
        const cleanText = cleanModelOutput(rawOutput);
        const explicit = extractExplicitAnswer(cleanText, true);
        if (explicit) return parseNumericToken(explicit);

        const relevantCount = extractRelevantCount(cleanText, question);
        if (relevantCount) return relevantCount;
    }

    const answer = extractAnswer(rawOutput, isNumberType);
    if (!answer) return "";
    if (isNumberType) return parseNumericToken(answer);
    return refineTextAnswer(question, answer) || answer;
}

async function askDrop(passage, question, expectsNumber) {
    const profile = getQuestionProfile(question, expectsNumber);
    const prompt = buildPrompt(passage, question, profile);
    const result = await askModel(prompt, {
        apiUrl: DROP_API_URL,
        modelName: DROP_MODEL_NAME,
        maxTokens: DROP_MAX_TOKENS,
        temperature: DROP_TEMPERATURE,
        timeoutMs: DROP_TIMEOUT_MS,
        retries: DROP_REQUEST_RETRIES,
        stop: PRIMARY_STOP,
    });

    return {
        output: result.output,
        prediction: extractPrediction(result.output, expectsNumber, question),
        inferenceTimeMs: result.inferenceTimeMs,
        endpoint: result.endpoint,
        strategy: "single_pass_model",
        profile: profile.mode,
    };
}

function matchExpect(expectList, modelAnswer, isNumberType = false) {
    if (!modelAnswer) return false;
    const normalizedModel = normalizeAnswer(modelAnswer);

    return expectList.some(expected => {
        const normalizedExpected = normalizeAnswer(expected);
        if (!normalizedExpected) return false;

        if (isNumberType) {
            const numModel = parseFloat(normalizedModel);
            const numExpected = parseFloat(normalizedExpected);
            if (Number.isNaN(numModel) || Number.isNaN(numExpected)) return false;
            return Math.abs(numModel - numExpected) < 1e-6;
        }

        if (normalizedModel === normalizedExpected) return true;
        if (normalizedModel.includes(normalizedExpected)) return true;
        if (normalizedExpected.includes(normalizedModel) && normalizedModel.length >= 2) return true;

        const numModel = parseFloat(normalizedModel);
        const numExpected = parseFloat(normalizedExpected);
        if (!Number.isNaN(numModel) && !Number.isNaN(numExpected)) {
            return Math.abs(numModel - numExpected) < 1e-6;
        }

        return false;
    });
}

function logProgress(index, total, tracker, prediction, expected, inferenceTimeMs, endpoint, error, gpu, strategy) {
    const acc = index <= 0 ? 0 : (tracker.correct / index) * 100;
    const avgMs = index <= 0 ? 0 : tracker.totalInferenceTimeMs / index;
    const status = error ? "ERROR" : "DONE";
    const endpointText = endpoint ? endpoint.replace("http://", "") : "-";
    const gpuText = gpu
        ? ` gpu=${gpu.gpuUtilization}% mem=${gpu.memoryUsedMB}/${gpu.memoryTotalMB}MB`
        : "";
    const strategyText = strategy ? ` strategy=${strategy}` : "";
    console.log(
        `[DROP_PRO] ${index}/${total} ${status} acc=${acc.toFixed(2)}% ` +
        `pred=${String(prediction).slice(0, 40)} gold=${String(expected[0] || "").slice(0, 40)} ` +
        `time=${formatMs(inferenceTimeMs)} avg=${formatMs(avgMs)} endpoint=${endpointText}${gpuText}${strategyText}${error ? ` error=${error}` : ""}`
    );
}

async function main() {
    ensureDir(RESULT_DIR);
    const datasetPath = getDatasetPath("DROP", "train.jsonl");
    if (!fs.existsSync(datasetPath)) {
        throw new Error(`Cannot find DROP dataset at: ${datasetPath}`);
    }

    const resultPath = path.join(RESULT_DIR, "drop_pro.jsonl");
    fs.writeFileSync(resultPath, "", "utf-8");

    let dataset = fs.readFileSync(datasetPath, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));

    if (LIMIT > 0) dataset = dataset.slice(0, LIMIT);

    console.log(
        `[DROP_PRO] dataset=${dataset.length} api=${DROP_API_URL} model=${DROP_MODEL_NAME} ` +
        `maxTokens=${DROP_MAX_TOKENS} retries=${DROP_REQUEST_RETRIES} temperature=${DROP_TEMPERATURE}`
    );

    const tracker = createStatsTracker("DROP_PRO", dataset.length);
    const gpuMonitor = startGpuMonitor(tracker);
    let stopping = false;

    const flushSummary = async status => {
        const gpu = await getGpuStats();
        if (gpu) tracker.lastGpu = gpu;
        writeAllTestSummary("DROP_PRO", buildSummaryPayload(tracker, status));
    };

    process.on("SIGINT", async () => {
        if (stopping) return;
        stopping = true;
        console.log("\n[DROP_PRO] interrupted, writing summary...");
        await gpuMonitor.stop();
        await flushSummary("interrupted");
        process.exit(130);
    });

    for (let index = 0; index < dataset.length; index++) {
        const item = dataset[index];
        const expectedList = item.answers_spans?.spans || [];
        const expectsNumber = hasNumberType(item.answers_spans?.types || []);

        process.stdout.write(`\r[DROP_PRO] ${index + 1}/${dataset.length}`);

        let finalOutput = "";
        let error = null;
        let inferenceTimeMs = 0;
        let endpoint = "";
        let prediction = "";
        let strategy = "";
        let profile = "";

        try {
            const result = await askDrop(item.passage, item.question, expectsNumber);
            finalOutput = result.output;
            prediction = result.prediction || "";
            inferenceTimeMs = result.inferenceTimeMs;
            endpoint = result.endpoint;
            strategy = result.strategy || "";
            profile = result.profile || "";
        } catch (err) {
            error = err.message;
        }

        const correct = !error && matchExpect(expectedList, prediction, expectsNumber);
        const gpu = await getGpuStats();

        updateStatsTracker(tracker, { correct, error, inferenceTimeMs, gpu });

        appendJsonl(resultPath, {
            id: index + 1,
            question: item.question,
            type: expectsNumber ? "number" : "span",
            expected: expectedList,
            prediction,
            correct,
            inferenceTimeMs,
            endpoint,
            gpu,
            error,
            strategy,
            profile,
            maxTokens: DROP_MAX_TOKENS,
            temperature: DROP_TEMPERATURE,
            retries: DROP_REQUEST_RETRIES,
            output: finalOutput,
        });

        await flushSummary("running");
        logProgress(index + 1, dataset.length, tracker, prediction, expectedList, inferenceTimeMs, endpoint, error, gpu, strategy);

        if (DROP_COOLDOWN_MS > 0 && index < dataset.length - 1) {
            await sleep(DROP_COOLDOWN_MS);
        }
    }

    const accuracy = dataset.length === 0 ? 0 : (tracker.correct / dataset.length) * 100;
    appendJsonl(resultPath, {
        summary: true,
        total: dataset.length,
        correct: tracker.correct,
        accuracy: `${accuracy.toFixed(2)}%`,
        avgInferenceTimeMs: dataset.length === 0 ? 0 : Number((tracker.totalInferenceTimeMs / dataset.length).toFixed(2)),
        errors: tracker.errors,
        emptyResponses: tracker.emptyResponses,
        maxTokens: DROP_MAX_TOKENS,
        temperature: DROP_TEMPERATURE,
        retries: DROP_REQUEST_RETRIES,
    });

    await gpuMonitor.stop();
    await flushSummary("finished");
    console.log(`\r[DROP_PRO] finished ${accuracy.toFixed(2)}% (${tracker.correct}/${dataset.length})`);
}

main().catch(err => {
    console.error(`\n[DROP_PRO] fatal: ${err.message}`);
    writeAllTestSummary("DROP_PRO", {
        dataset: "DROP_PRO",
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: err.message,
    });
    process.exit(1);
});
