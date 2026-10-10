/** One plain sentence from model prose: no markdown marks, cut at the first sentence end. */
export function plainLine(value: unknown, limit = 90): string {
  const text = String(value ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim()
  const end = text.search(/[。！？!?]|\.\s/)
  const sentence = end > 0 && end < limit ? text.slice(0, end + 1) : text
  return sentence.length > limit ? `${sentence.slice(0, limit - 1)}…` : sentence
}
