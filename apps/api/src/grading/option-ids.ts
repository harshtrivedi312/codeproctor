// MCQ option ids as the candidate sees them. ADR 0013 section 5.10 CS-4.6 makes them opaque per
// session (`opt_` plus HMAC of the session id and the option id under QUESTION_OPTION_ID_SECRET), and
// `grade-session` recomputes the mapping. The candidate question read (render-question) and that
// secret do not exist yet, so the mapping is the identity here. Draft and grading both go through
// this one function, so the day the secret lands only this file changes (FU-BEB-74).
export function candidateOptionId(_sessionId: string, optionId: string): string {
  return optionId;
}
