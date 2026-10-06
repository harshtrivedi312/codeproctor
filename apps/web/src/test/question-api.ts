import { isFullQuestion, type FullQuestion, type QuestionView } from '@/features/questions/queries';

/** Narrows a detail response to the full detail a writer gets; throws on the redacted view. */
export function full(d: QuestionView | undefined): FullQuestion {
  if (!d || !isFullQuestion(d)) throw new Error('expected the full question detail');
  return d;
}
