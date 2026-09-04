import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import type { z } from 'zod'
import { loadConfig } from '../config.js'
import { logger } from '../logger.js'

/**
 * Thin wrapper over the official `openai` SDK. Everything goes through the
 * Responses API with a zod-derived strict JSON schema, so there is no output
 * parsing anywhere in this codebase — a malformed response is the SDK's problem
 * and it retries at that layer.
 */

let client: OpenAI | undefined

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: loadConfig().OPENAI_API_KEY,
      // The SDK's own retry handles 429s and transient 5xxs.
      maxRetries: 4,
      timeout: 120_000,
    })
  }
  return client
}

export interface StructuredCallOptions<T extends z.ZodType> {
  model: string
  /** Name for the schema — surfaced in the API's error messages. */
  schemaName: string
  schema: T
  system: string
  user: string
  /** Label for logging, e.g. "triage" / "thesis". */
  label: string
}

/**
 * One structured completion. Returns null rather than throwing when the model
 * declines or the call fails: a failed cycle should skip an event, never crash
 * the worker.
 */
export async function structured<T extends z.ZodType>(
  opts: StructuredCallOptions<T>,
): Promise<z.infer<T> | null> {
  const started = Date.now()
  try {
    const res = await getClient().responses.parse({
      model: opts.model,
      input: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      text: { format: zodTextFormat(opts.schema, opts.schemaName) },
    })

    if (res.output_parsed == null) {
      logger.warn(
        { label: opts.label, status: res.status, incomplete: res.incomplete_details },
        'llm returned no parsed output',
      )
      return null
    }

    logger.debug(
      {
        label: opts.label,
        model: opts.model,
        ms: Date.now() - started,
        inputTokens: res.usage?.input_tokens,
        outputTokens: res.usage?.output_tokens,
      },
      'llm call complete',
    )
    return res.output_parsed
  } catch (err) {
    logger.error({ err, label: opts.label, model: opts.model }, 'llm call failed')
    return null
  }
}
