declare namespace Express {
  interface Request {
    requestId: string;
    user?: {
      id: string;
      role: 'patient' | 'doctor' | 'admin';
      sessionId: string;
    };
  }
}
