'use client';

import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ExpenseForm, type ExpenseDraft } from '@/components/finance/expense-form';

/** Corrects a recorded expense in a dialog; the change is kept in the audit log. */
export function EditExpenseButton({
  expense,
  categories,
  defaultVatRate,
}: {
  expense: ExpenseDraft;
  categories: { id: string; accountCode: string; accountName: string }[];
  defaultVatRate: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm" aria-label={`Edit ${expense.description}`}>
            <Pencil />
            Edit
          </Button>
        }
      />
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit expense</DialogTitle>
          <DialogDescription>
            Correct what was recorded. The original is kept in the history.
          </DialogDescription>
        </DialogHeader>
        <ExpenseForm
          categories={categories}
          defaultVatRate={defaultVatRate}
          expense={expense}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
