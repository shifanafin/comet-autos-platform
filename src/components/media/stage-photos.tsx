'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, ImagePlus, Loader2, RotateCw, TriangleAlert } from 'lucide-react';
import type { MediaStage } from '@/generated/prisma/enums';
import { MEDIA_STAGE_LABEL } from '@/lib/media/stages';
import { newRequestKey, prepareImage, sendPhotos } from '@/lib/media/client';
import { PhotoViewer, type PhotoItem } from '@/components/media/photo-viewer';
import { cn } from '@/lib/utils';

/*
 * Photographing the work where the work happens.
 *
 * A technician on the inspection, diagnosis, repair, quality-check or
 * delivery screen taps once, the camera opens, and the photo is on the job
 * before the camera closes. The stage is fixed by the screen they are on,
 * so there is nothing to choose and nothing to type — the two things that
 * made the old route (back to the job card, open the gallery, pick a stage
 * from a dropdown) unusable with dirty hands on a phone.
 */

interface Pending {
  key: string;
  url: string;
  state: 'uploading' | 'done' | 'failed';
  files: File[];
  requestKey: string;
  percent: number;
  /** The server's reason, already phrased for the person holding the phone. */
  error?: string;
}

export function StagePhotos({
  jobCardId,
  stage,
  photos,
  canEdit,
  hint,
  className,
}: {
  jobCardId: string;
  stage: MediaStage;
  /** Photos already on the job for this stage, oldest first. */
  photos: PhotoItem[];
  canEdit: boolean;
  hint?: string;
  className?: string;
}) {
  const router = useRouter();
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [viewer, setViewer] = useState<number | null>(null);
  const label = MEDIA_STAGE_LABEL[stage].toLowerCase();

  // Every preview URL made in this session, so none is left behind.
  const urls = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
    },
    [],
  );

  // A local preview stands in for a photo until the server list catches up
  // with it. Adjusting during render rather than in an effect: the two
  // states are one truth, and an effect here would cost an extra pass.
  const [settledCount, setSettledCount] = useState(photos.length);
  if (photos.length !== settledCount) {
    setSettledCount(photos.length);
    setPending((current) => current.filter((item) => item.state !== 'done'));
  }

  async function send(key: string, files: File[], requestKey: string) {
    const result = await sendPhotos({
      jobCardId,
      files,
      stage,
      requestKey,
      onProgress: (percent) =>
        setPending((current) =>
          current.map((item) => (item.key === key ? { ...item, percent } : item)),
        ),
    });
    setPending((current) =>
      current.map((item) =>
        item.key === key
          ? { ...item, state: result.ok ? 'done' : 'failed', error: result.error }
          : item,
      ),
    );
    if (result.ok) router.refresh();
    return result;
  }

  async function onPick(list: FileList | null) {
    if (!list || list.length === 0) return;
    const files = await Promise.all(Array.from(list).slice(0, 12).map(prepareImage));
    if (cameraRef.current) cameraRef.current.value = '';
    if (galleryRef.current) galleryRef.current.value = '';
    // One entry per photo, so a preview appears the instant it is taken.
    const entries: Pending[] = files.map((file) => {
      const url = URL.createObjectURL(file);
      urls.current.push(url);
      return {
        key: newRequestKey(),
        url,
        state: 'uploading' as const,
        files: [file],
        requestKey: newRequestKey(),
        percent: 0,
      };
    });
    setPending((current) => [...current, ...entries]);
    for (const entry of entries) await send(entry.key, entry.files, entry.requestKey);
  }

  function retry(item: Pending) {
    setPending((current) =>
      current.map((p) => (p.key === item.key ? { ...p, state: 'uploading', percent: 0 } : p)),
    );
    // The same request key: a retry after a timeout that actually landed
    // is recognised as the same submission and does not add a second copy.
    void send(item.key, item.files, item.requestKey);
  }

  const failed = pending.filter((item) => item.state === 'failed');
  const total = photos.length + pending.filter((item) => item.state !== 'failed').length;

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-label={`Take a ${label} photo`}
        onChange={(event) => onPick(event.target.files)}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/*"
        multiple
        className="sr-only"
        aria-label={`Choose ${label} photos`}
        onChange={(event) => onPick(event.target.files)}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {MEDIA_STAGE_LABEL[stage]} photos
          {total > 0 ? (
            <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{total}</span>
          ) : null}
        </p>
        {hint && total === 0 ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>

      {canEdit ? (
        // A phone gets its camera and its gallery; a computer, one upload.
        <div className="grid grid-cols-2 gap-2 pointer-fine:grid-cols-1">
          <button
            type="button"
            onClick={() => cameraRef.current?.click()}
            className="flex h-14 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-base font-medium text-primary-foreground transition-colors hover:bg-primary-hover active:bg-primary-hover pointer-fine:hidden sm:h-12 sm:text-sm"
          >
            <Camera className="size-5" />
            Take photo
          </button>
          <button
            type="button"
            onClick={() => galleryRef.current?.click()}
            className="flex h-14 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-base font-medium transition-colors hover:bg-muted active:bg-muted sm:h-12 sm:text-sm"
          >
            <ImagePlus className="size-5" />
            <span className="pointer-fine:hidden">Gallery</span>
            <span className="hidden pointer-fine:inline">Upload {label} photos</span>
          </button>
        </div>
      ) : null}

      {total > 0 ? (
        <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 scrollbar-none">
          {photos.map((photo, index) => (
            <li key={photo.id} className="shrink-0">
              <button
                type="button"
                onClick={() => setViewer(index)}
                className="block size-20 overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:size-24"
                aria-label={`${MEDIA_STAGE_LABEL[photo.stage]} photo${photo.description ? `: ${photo.description}` : ''}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/media/${photo.id}`}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="size-full object-cover"
                />
              </button>
            </li>
          ))}
          {pending
            .filter((item) => item.state !== 'failed')
            .map((item) => (
              <li key={item.key} className="shrink-0">
                <div className="relative size-20 overflow-hidden rounded-lg bg-muted sm:size-24">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.url} alt="" className="size-full object-cover opacity-60" />
                  <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/25 text-white">
                    <Loader2 className="size-5 animate-spin" />
                    <span className="text-[10px] font-medium tabular-nums">
                      {item.percent > 0 && item.percent < 100 ? `${item.percent}%` : 'Saving'}
                    </span>
                  </span>
                </div>
              </li>
            ))}
        </ul>
      ) : canEdit ? null : (
        <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">
          No {label} photos on this job.
        </p>
      )}

      {failed.map((item) => (
        <div
          key={item.key}
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.url} alt="" className="size-10 shrink-0 rounded-md object-cover" />
          <span className="min-w-0 flex-1 text-xs text-destructive">
            <TriangleAlert className="mr-1 inline size-3.5 shrink-0 align-[-2px]" />
            {item.error ?? 'This photo wasn’t saved.'} It is still here — try again.
          </span>
          <button
            type="button"
            onClick={() => retry(item)}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium hover:bg-muted"
          >
            <RotateCw className="size-3.5" />
            Retry
          </button>
        </div>
      ))}

      <PhotoViewer
        jobCardId={jobCardId}
        photos={photos}
        index={viewer}
        onIndexChange={setViewer}
        onClose={() => setViewer(null)}
        canEdit={canEdit}
      />
    </div>
  );
}
