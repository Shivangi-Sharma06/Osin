import type { Collector, InputType } from './types.js';
import { GithubCollector } from './github.js';

/** All registered collectors. New collectors (Tasks 9/11) register here. */
export const collectors: Collector[] = [new GithubCollector()];

export function enabledCollectorsFor(inputType: InputType): Collector[] {
  return collectors.filter((c) => c.isEnabled() && c.appliesTo.includes(inputType));
}
