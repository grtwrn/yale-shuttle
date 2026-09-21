import { expect, it } from 'vitest';
import { k10TrialSelected, withoutEtaTrial } from './etaTrial';
it('requires explicit opt-in and removes only that option on rollback', () => {
  expect(k10TrialSelected('')).toBe(false);
  expect(k10TrialSelected('?eta_model=unknown')).toBe(false);
  expect(k10TrialSelected('?eta_model=k10')).toBe(true);
  expect(withoutEtaTrial('https://yale-shuttle.fly.dev/?eta_model=k10&stop=48#map')).toBe('/?stop=48#map');
});
