'use client';

import { useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * A one-time password, shown once: the person signs in with it and must
 * choose their own straight away. It is never shown again — a lost one is
 * replaced with "Reset password".
 */
export function IssuedPassword({ username, password }: { username: string; password: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <KeyRound className="size-4 shrink-0" />
        Their login is ready — give them these privately
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Signs in as</dt>
        <dd className="font-mono font-semibold">{username}</dd>
        <dt className="text-muted-foreground">One-time password</dt>
        <dd className="font-mono text-base font-semibold tracking-wider">{password}</dd>
      </dl>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(password);
              setCopied(true);
            } catch {
              // Clipboard blocked: they can still read it off the screen.
            }
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copied' : 'Copy password'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        It is shown only now. They must choose their own password at the first sign-in.
      </p>
    </div>
  );
}
