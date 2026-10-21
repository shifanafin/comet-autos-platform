'use client';

import { startTransition, useActionState, useRef, type FormEvent } from 'react';

/** A random one-time key. Uses getRandomValues, which (unlike randomUUID) also works on plain-http workshop tablets. */
function newRequestKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * useActionState for forms that must keep what the user typed when the
 * server rejects it. Passing an action straight to <form action> makes React
 * reset every uncontrolled field after submission — including on validation
 * errors — so this submits via onSubmit instead.
 *
 * It also makes submitting safe to repeat:
 *  - a second submit while the first is still running is ignored;
 *  - every submission carries a one-time `requestKey`, kept until the server
 *    accepts it, so the server can recognise a repeat (double click, retry
 *    after a slow response) and record it only once (lib/request-keys.ts).
 *    A new key is issued after each success, for the next entry.
 */
export function useFormAction<State>(
  action: (state: Awaited<State>, formData: FormData) => State | Promise<State>,
  initialState: Awaited<State>,
) {
  const requestKey = useRef<string | null>(null);
  const inFlight = useRef(false);

  const [state, dispatch, isPending] = useActionState(
    async (previous: Awaited<State>, formData: FormData) => {
      try {
        const result = await action(previous, formData);
        if ((result as { ok?: boolean } | null)?.ok) requestKey.current = null;
        return result;
      } finally {
        inFlight.current = false;
      }
    },
    initialState,
  );

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    requestKey.current ??= newRequestKey();
    // With the button pressed, so a form with two (Save, Save & close) knows which.
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget, submitter ?? undefined);
    formData.set('requestKey', requestKey.current);
    startTransition(() => dispatch(formData));
  }
  return [state, onSubmit, isPending] as const;
}
