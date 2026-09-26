'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, ImageOff, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { MediaStage } from '@/generated/prisma/enums';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ConfirmAction } from '@/components/shared/confirm-action';
import { MEDIA_STAGE_LABEL } from '@/lib/media/stages';
import { removePhotoAction } from '@/app/(app)/job-cards/[id]/actions';

export interface PhotoItem {
  id: string;
  stage: MediaStage;
  description: string | null;
  createdAt: string;
  uploadedBy: string;
}

/**
 * The full-size photo, wherever it was opened from. Bytes come from the
 * permission-checked `/media/[id]` route by document id — the storage
 * location is never in the page.
 */
export function PhotoViewer({
  jobCardId,
  photos,
  index,
  onIndexChange,
  onClose,
  canEdit,
}: {
  jobCardId: string;
  photos: PhotoItem[];
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [isRemoving, startRemoving] = useTransition();
  const current = index !== null ? photos[index] : null;

  return (
    <Dialog open={index !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl gap-3 p-3 sm:p-4" showCloseButton={false}>
        {current ? (
          <>
            <DialogTitle className="sr-only">{MEDIA_STAGE_LABEL[current.stage]} photo</DialogTitle>
            <div className="relative flex items-center justify-center overflow-hidden rounded-md bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/media/${current.id}`}
                alt={current.description ?? `${MEDIA_STAGE_LABEL[current.stage]} photo`}
                className="max-h-[70dvh] w-auto object-contain"
              />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="absolute top-2 right-2 flex size-10 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
              >
                <X className="size-5" />
              </button>
              {index! > 0 ? (
                <button
                  type="button"
                  onClick={() => onIndexChange(index! - 1)}
                  aria-label="Previous photo"
                  className="absolute left-2 flex size-11 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
                >
                  <ChevronLeft className="size-6" />
                </button>
              ) : null}
              {index! < photos.length - 1 ? (
                <button
                  type="button"
                  onClick={() => onIndexChange(index! + 1)}
                  aria-label="Next photo"
                  className="absolute right-2 flex size-11 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
                >
                  <ChevronRight className="size-6" />
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-start justify-between gap-3 px-1">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {MEDIA_STAGE_LABEL[current.stage]}
                  <span className="font-normal text-muted-foreground">
                    {' '}
                    · {index! + 1} of {photos.length}
                  </span>
                </p>
                {current.description ? <p className="text-sm">{current.description}</p> : null}
                <p className="text-xs text-muted-foreground">
                  Added by {current.uploadedBy} · {current.createdAt}
                </p>
              </div>
              {canEdit ? (
                <ConfirmAction
                  trigger={
                    <Button variant="ghost" size="sm" className="text-destructive" disabled={isRemoving}>
                      <Trash2 />
                      Remove
                    </Button>
                  }
                  title="Remove this photo from the job?"
                  description="It will no longer show on the job card. The removal is recorded with your name."
                  confirmLabel="Remove photo"
                  onConfirm={async () =>
                    startRemoving(async () => {
                      const result = await removePhotoAction(jobCardId, current.id);
                      if (!result.ok) {
                        toast.error(result.error ?? 'The photo could not be removed.');
                        return;
                      }
                      toast.success('Photo removed');
                      onClose();
                      router.refresh();
                    })
                  }
                />
              ) : null}
            </div>
          </>
        ) : (
          <>
            <DialogTitle className="sr-only">Photo</DialogTitle>
            <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
              <ImageOff className="size-6" />
              Photo not available
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
