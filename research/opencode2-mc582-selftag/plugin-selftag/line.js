// The variant C system line of Magic Context's self-tag trial, byte for byte.
// Sources it must equal (run.mjs checks both before every run and refuses to
// start on any difference):
//   magic-context/.cortexkit/alfonso/plans/issue-582-variant-c.md,
//     section "Variant C system line" (the blockquote)
//   magic-context/packages/plugin/scripts/self-tag-trial/host-plugin.mjs,
//     constant instructionC
export const VARIANT_C_LINE =
    'Every user message, every text you write and every tool result in this conversation carries a tag such as §12§, numbered in the order they arrive. Start the text of each reply with exactly §N§ and one space, where N is one more than the highest tag number you can see, tool results included. That applies to every reply that has text, including a short sentence written alongside tool calls, for example `§12§ Reading both files in parallel.` followed by the calls. A reply that is only tool calls gets no tag. IMPORTANT: NEVER write tag notation anywhere else: not mid-text and not in tool arguments. To refer to an item in your prose, write "tag 12".';
