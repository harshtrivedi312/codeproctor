import type { Schemas } from '@/lib/api/client';

export const TYPE_LABEL: Record<Schemas['QuestionType'], string> = {
  CODING: 'Coding',
  MCQ: 'Multiple choice',
  SHORT_ANSWER: 'Short answer',
};

export const DIFFICULTY_LABEL: Record<Schemas['Difficulty'], string> = {
  EASY: 'Easy',
  MEDIUM: 'Medium',
  HARD: 'Hard',
};

export const STATUS_LABEL: Record<'DRAFT' | 'PUBLISHED' | 'ARCHIVED', string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};
