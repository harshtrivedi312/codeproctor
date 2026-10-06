import { PhoneHandoff } from '@/features/candidate-phone/phone-handoff';

/** Entry for links shaped /t/phone/enter#<token>; the fragment never reaches the server. */
export default function PhoneEntryPage() {
  return <PhoneHandoff />;
}
