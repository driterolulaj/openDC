// SPDX-License-Identifier: AGPL-3.0-only
/** Follows a job until it finishes (polling; jobs also stream over SSE for long-running views). */
import { useQuery } from '@tanstack/react-query';
import { job } from '@opendc/shared/api';
import { api } from './api.ts';

export function useJob(id: string | null) {
  return useQuery({
    queryKey: ['job', id],
    queryFn: () => api(`/jobs/${id ?? ''}`, { schema: job }),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'running' ? false : 1000),
  });
}
