import type { Collector, InputType } from './types.js';
import { GithubCollector } from './github.js';
import { UsernameFanoutCollector } from './usernameFanout.js';
import { OfficialSocialCollector } from './officialSocial.js';
import { EmailCollector } from './emailHolehe.js';
import { PhoneCollector } from './phoneInfoga.js';
import { NameSearchCollector } from './nameSearch.js';
import {
  CertificateTransparencyCollector,
  DnsCollector,
  RdapCollector,
  TechStackCollector,
} from './domain.js';

/** All registered collectors. Domain collectors (Task 11) register here too. */
export const collectors: Collector[] = [
  new GithubCollector(),
  new UsernameFanoutCollector(),
  new OfficialSocialCollector(),
  new EmailCollector(),
  new PhoneCollector(),
  new NameSearchCollector(),
  new DnsCollector(),
  new RdapCollector(),
  new CertificateTransparencyCollector(),
  new TechStackCollector(),
];

export function enabledCollectorsFor(inputType: InputType): Collector[] {
  return collectors.filter((c) => c.isEnabled() && c.appliesTo.includes(inputType));
}
