import { expect, it } from 'vitest';
import { k10TrialSelected, etaChoiceUrl } from './etaTrial';
it('uses K10 by default with a reversible opt-out that preserves route choices', () => {
  expect(k10TrialSelected('')).toBe(true);
  expect(k10TrialSelected('?eta_model=unknown')).toBe(true);
  expect(k10TrialSelected('?eta_model=k10')).toBe(true);
  expect(k10TrialSelected('?eta_model=usual')).toBe(false);
  expect(etaChoiceUrl('https://yale-shuttle.fly.dev/?stop=48#map',true)).toBe('/?stop=48&eta_model=usual#map');
  expect(etaChoiceUrl('https://yale-shuttle.fly.dev/?eta_model=usual&stop=48#map',false)).toBe('/?stop=48#map');
});
