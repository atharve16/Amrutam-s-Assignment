import { UserRole } from '../auth/auth.types';
import { ConsultationStatus } from './dto/consultation-query.dto';

const TRANSITIONS: Record<ConsultationStatus, readonly ConsultationStatus[]> = {
  scheduled: ['in_progress', 'completed', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function canTransitionConsultation(
  current: ConsultationStatus,
  next: ConsultationStatus,
  role: UserRole,
): boolean {
  if (!TRANSITIONS[current].includes(next)) return false;
  if (role === 'patient') return current === 'scheduled' && next === 'cancelled';
  return role === 'doctor' || role === 'admin';
}
