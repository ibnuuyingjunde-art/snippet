import crypto from "node:crypto";

const API = "https://api.overchat.ai/v1/chat/completions";

const UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

/**
 * Presets of models that are confirmed to be completely FREE and unlimited
 * (do not require credits and do not trigger 403 quota limits).
 */
export const PRESETS = {
  haiku: {
    name: "Claude Haiku 4.5",
    model: "claude-haiku-4-5-20251001",
    personaId: "claude-haiku-4-5-landing",
  },
  gpt5: {
    name: "GPT-4.1 Nano (GPT 5)",
    model: "openai/gpt-4.1-nano-2025-04-14",
    personaId: "gpt-4o-landing",
  },
  deepseek: {
    name: "DeepSeek V3.2",
    model: "deepseek/deepseek-non-thinking-v3.2-exp",
    personaId: "deepseek-v-3-2-landing",
  },
};

/**
 * Unified function to request Overchat AI models.
 *
 * @param {string} prompt - The question or instruction.
 * @param {object} options - Custom options.
 * @param {string} [options.preset] - Optional preset name ('haiku', 'gpt5', or 'deepseek').
 * @param {string} [options.model] - Manually specify model name (overrides preset).
 * @param {string} [options.personaId] - Manually specify persona ID (overrides preset).
 * @param {string} [options.chatId] - Persist conversation thread.
 * @param {string} [options.deviceId] - Persist device context.
 * @param {Array} [options.history] - Chat history array for conversational models.
 * @param {boolean} [options.stream=true] - Stream the completion chunk by chunk.
 * @param {number} [options.temperature=0.5] - Sampling temperature.
 * @returns {Promise<object>} Returns the response object.
 */
export async function askOverchat(prompt, options = {}) {
  let modelName = options.model;
  let personaId = options.personaId;

  // Apply preset values if a valid preset is requested
  if (options.preset && PRESETS[options.preset]) {
    const preset = PRESETS[options.preset];
    modelName = modelName || preset.model;
    personaId = personaId || preset.personaId;
  }

  // Fallback to default model if none specified
  modelName = modelName || PRESETS.gpt5.model;
  personaId = personaId || PRESETS.gpt5.personaId;

  const chatId = options.chatId || crypto.randomUUID();
  const deviceId = options.deviceId || crypto.randomUUID();
  const stream = options.stream !== false;

  const messages = [
    ...(options.history || []).map((item) => ({
      id: crypto.randomUUID(),
      role: item.role,
      content: item.content,
    })),
    {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
    },
  ];

  // Add default system message if not overridden by history
  if (!options.history) {
    messages.push({
      id: crypto.randomUUID(),
      role: "system",
      content: "Ikuti bahasa user dan jawab dengan gaya natural, singkat, dan jelas.",
    });
  }

  const body = {
    chatId,
    model: modelName,
    messages,
    personaId,
    frequency_penalty: 0,
    max_tokens: 4000,
    presence_penalty: 0,
    stream,
    temperature: options.temperature || 0.5,
    top_p: 0.95,
  };

  const headers = {
    "sec-ch-ua-platform": `"Android"`,
    "x-device-uuid": deviceId,
    "sec-ch-ua": `"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"`,
    "sec-ch-ua-mobile": "?1",
    "x-device-language": "id-ID",
    "x-device-platform": "web",
    "x-device-version": "1.0.44",
    "user-agent": UA,
    accept: "*/*",
    "content-type": "application/json",
    origin: "https://overchat.ai",
    referer: "https://overchat.ai/",
    "accept-language": "id-ID,id;q=0.9",
  };

  const response = await fetch(API, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      status: false,
      code: response.status,
      error: text,
      model: modelName,
      personaId,
    };
  }

  let answer = "";
  let responseId = null;
  let responseModel = null;

  if (stream) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const json = JSON.parse(data);
          if (json.id) responseId = json.id;
          if (json.model) responseModel = json.model;

          const content = json.choices?.[0]?.delta?.content;
          if (typeof content === "string") {
            answer += content;
          }
        } catch {}
      }
    }
  } else {
    const json = await response.json();
    responseId = json.id;
    responseModel = json.model;
    answer = json.choices?.[0]?.message?.content || "";
  }

  return {
    status: true,
    code: response.status,
    chatId,
    deviceId,
    responseId,
    model: responseModel || modelName,
    personaId,
    answer,
  };
}
