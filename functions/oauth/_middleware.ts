// Error boundary for every /oauth/* Function (see src/api/http.ts errorBoundary).
import { errorBoundary } from '../../src/api/http';

export const onRequest = errorBoundary;
