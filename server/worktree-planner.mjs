const UNUSABLE = "The planner returned an unusable answer. Try again";

export function parsePlannerReply(stdout) {
  const envelope = extractJson(String(stdout));
  if (!envelope) throw new TypeError(UNUSABLE);
  const sessionId = typeof envelope.session_id === "string" ? envelope.session_id : null;
  const payload = extractJson(unfence(String(envelope.result || "")));
  if (!payload) throw new TypeError(UNUSABLE);

  const hasQuestions = Array.isArray(payload.questions) && payload.questions.length > 0;
  const hasTasks = Array.isArray(payload.tasks) && payload.tasks.length > 0;
  if (hasQuestions === hasTasks) throw new TypeError(UNUSABLE);

  if (hasQuestions) {
    const questions = payload.questions
      .map((item, index) => ({
        id: `q${index + 1}`,
        text: cleanText(item?.text || item?.question),
        options: Array.isArray(item?.options) ? item.options.map(cleanText).filter(Boolean).slice(0, 6) : [],
      }))
      .filter((item) => item.text);
    if (!questions.length) throw new TypeError(UNUSABLE);
    return { sessionId, status: "questions", questions, tasks: [] };
  }

  const tasks = payload.tasks
    .map((item, index) => ({
      id: `t${index + 1}`,
      title: cleanText(item?.title),
      branch: cleanText(item?.branch),
      prompt: cleanText(item?.prompt),
    }))
    .filter((item) => item.title && item.branch && item.prompt);
  if (!tasks.length) throw new TypeError(UNUSABLE);
  return { sessionId, status: "ready", questions: [], tasks };
}

function unfence(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fence ? fence[1] : text;
}

function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Keep shrinking: trailing prose after the object is common.
    }
  }
  return null;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim().slice(0, 4_000) : "";
}
