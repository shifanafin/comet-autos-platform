'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, ImagePlus, Images, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { MediaStage } from '@/generated/prisma/enums';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, NativeSelect } from '@/components/forms/fields';
import { MEDIA_STAGE_LABEL, MEDIA_STAGES } from '@/lib/media/stages';
import { newRequestKey, prepareImage, sendPhotos } from '@/lib/media/client';
import { PhotoViewer, type PhotoItem } from '@/components/media/photo-viewer';
import { cn } from '@/lib/utils';

export type { PhotoItem };

export function JobPhotos({
  jobCardId,
  photos,
  defaultStage,
  canEdit,
}: {
  jobCardId: string;
  photos: PhotoItem[];
  defaultStage: MediaStage;
  canEdit: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<MediaStage | 'ALL'>('ALL');
  const [picked, setPicked] = useState<{ file: File; url: string }[]>([]);
  const [stage, setStage] = useState<MediaStage>(defaultStage);
  const [caption, setCaption] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);

  const counts = useMemo(() => {
    const map = new Map<MediaStage, number>();
    for (const photo of photos) map.set(photo.stage, (map.get(photo.stage) ?? 0) + 1);
    return map;
  }, [photos]);
  const shown = filter === 'ALL' ? photos : photos.filter((photo) => photo.stage === filter);
  const VISIBLE = 8;

  /**
   * Gallery picks open the sheet, where a batch can be given a stage and a
   * caption. A photo straight from the camera is saved at once against the
   * stage the job is at — take it and carry on. If that save fails, the
   * sheet opens with the photo still in it and the reason shown, so the
   * retry (same request key) is one tap and nothing is lost.
   */
  async function onPick(files: FileList | null, source: 'camera' | 'gallery') {
    if (!files || files.length === 0) return;
    const prepared = await Promise.all(Array.from(files).slice(0, 12).map(prepareImage));
    if (inputRef.current) inputRef.current.value = '';
    if (cameraRef.current) cameraRef.current.value = '';
    const entries = prepared.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setStage(defaultStage);
    setCaption('');
    setUploadError(null);
    requestKey.current = newRequestKey();

    if (source === 'gallery') {
      setPicked(entries);
      return;
    }

    setProgress(0);
    const result = await sendPhotos({
      jobCardId,
      files: entries.map((entry) => entry.file),
      stage: defaultStage,
      requestKey: requestKey.current,
      onProgress: setProgress,
    });
    setProgress(null);
    if (!result.ok) {
      setUploadError(result.error ?? null);
      setPicked(entries);
      return;
    }
    entries.forEach((entry) => URL.revokeObjectURL(entry.url));
    requestKey.current = null;
    toast.success(`Photo saved to ${MEDIA_STAGE_LABEL[defaultStage]}`);
    setFilter('ALL');
    router.refresh();
  }

  function closeUpload() {
    if (progress !== null) return;
    picked.forEach((p) => URL.revokeObjectURL(p.url));
    setPicked([]);
  }

  async function upload() {
    if (progress !== null || picked.length === 0) return;
    const count = picked.length;
    setUploadError(null);
    setProgress(0);
    const result = await sendPhotos({
      jobCardId,
      files: picked.map((p) => p.file),
      stage,
      description: caption,
      // The same key on a retry, so a submission that actually landed is
      // never counted twice.
      requestKey: (requestKey.current ??= newRequestKey()),
      onProgress: setProgress,
    });
    setProgress(null);
    if (!result.ok) {
      setUploadError(result.error ?? null);
      return;
    }
    toast.success(`${count} photo${count === 1 ? '' : 's'} added to ${MEDIA_STAGE_LABEL[stage]}`);
    picked.forEach((p) => URL.revokeObjectURL(p.url));
    setPicked([]);
    requestKey.current = null;
    setFilter('ALL');
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/*"
        multiple
        className="sr-only"
        aria-label="Choose photos"
        onChange={(event) => onPick(event.target.files, 'gallery')}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-label="Take a photo"
        onChange={(event) => onPick(event.target.files, 'camera')}
      />

      <div className="flex items-center justify-between gap-3">
        <div className="-mx-1 flex min-w-0 gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
          {[{ key: 'ALL' as const, label: 'All', count: photos.length }, ...MEDIA_STAGES.filter((s) => counts.get(s.stage)).map((s) => ({ key: s.stage, label: s.label, count: counts.get(s.stage) ?? 0 }))].map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => setFilter(chip.key)}
              aria-pressed={filter === chip.key}
              className={cn(
                'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors',
                filter === chip.key ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-foreground/80 hover:bg-muted',
              )}
            >
              {chip.label}
              <span className={cn('tabular-nums', filter === chip.key ? 'text-background/70' : 'text-muted-foreground')}>{chip.count}</span>
            </button>
          ))}
        </div>
        {canEdit ? (
          // One way in per device: a phone gets its camera and its gallery;
          // a computer has no camera to open, so it gets a single upload.
          <div className="flex shrink-0 gap-2">
            <Button
              className="h-11 pointer-fine:hidden"
              disabled={progress !== null}
              onClick={() => cameraRef.current?.click()}
            >
              <Camera />
              Take photo
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={progress !== null}
              onClick={() => inputRef.current?.click()}
            >
              <ImagePlus />
              <span className="sr-only sm:not-sr-only pointer-fine:hidden">Gallery</span>
              <span className="hidden pointer-fine:inline">Upload photos</span>
            </Button>
          </div>
        ) : null}
      </div>

      {/* A camera photo saves without opening the sheet; show it happening here. */}
      {progress !== null && picked.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5" role="status" aria-live="polite">
          <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          <span className="text-sm">{progress < 100 ? `Saving photo… ${progress}%` : 'Saving photo…'}</span>
        </div>
      ) : null}

      {photos.length === 0 ? (
        // Words, not another camera: the buttons above are the way in.
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-8 text-center">
          <Images className="size-6 text-muted-foreground" />
          <span className="text-sm font-medium">No photos yet</span>
          <span className="max-w-sm text-xs text-muted-foreground">
            {canEdit ? 'Photograph the vehicle at intake, and the work as it happens — they are kept with this job.' : 'Photos added to this job appear here.'}
          </span>
        </div>
      ) : (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-4 2xl:grid-cols-6">
          {shown.slice(0, VISIBLE).map((photo, index) => (
            <li key={photo.id}>
              <button
                type="button"
                onClick={() => setViewer(index)}
                className="group relative block aspect-square w-full overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                aria-label={`${MEDIA_STAGE_LABEL[photo.stage]} photo${photo.description ? `: ${photo.description}` : ''}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/media/${photo.id}`} alt="" loading="lazy" decoding="async" className="size-full object-cover transition-transform group-hover:scale-[1.03]" />
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 pt-4 pb-1 text-left text-[10px] font-medium text-white">
                  {MEDIA_STAGE_LABEL[photo.stage]}
                </span>
              </button>
            </li>
          ))}
          {shown.length > VISIBLE ? (
            <li>
              <button
                type="button"
                onClick={() => setViewer(VISIBLE)}
                className="flex aspect-square w-full items-center justify-center rounded-md bg-muted text-sm font-medium text-muted-foreground hover:bg-muted/70"
              >
                +{shown.length - VISIBLE} more
              </button>
            </li>
          ) : null}
        </ul>
      )}

      {/* Upload sheet */}
      <Dialog open={picked.length > 0} onOpenChange={(open) => !open && closeUpload()}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Add {picked.length} photo{picked.length === 1 ? '' : 's'}
            </DialogTitle>
            <DialogDescription>They are saved with this job and can be seen by the team.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {picked.map((p) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={p.url} src={p.url} alt="" className="aspect-square w-full rounded-md object-cover" />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Stage" htmlFor="photo-stage">
              <NativeSelect id="photo-stage" value={stage} onChange={(event) => setStage(event.target.value as MediaStage)} className="h-11 text-base md:text-sm">
                {MEDIA_STAGES.map((s) => (
                  <option key={s.stage} value={s.stage}>
                    {s.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Caption" htmlFor="photo-caption" hint="Optional">
              <input
                id="photo-caption"
                value={caption}
                maxLength={300}
                onChange={(event) => setCaption(event.target.value)}
                placeholder="e.g. Scratch on rear bumper"
                className="h-11 w-full rounded-lg border border-input bg-card px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
              />
            </Field>
          </div>
          {progress !== null ? (
            <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
              </div>
              <span className="text-xs text-muted-foreground">{progress < 100 ? `Uploading… ${progress}%` : 'Saving…'}</span>
            </div>
          ) : null}
          {uploadError ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
              {uploadError}
            </p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <Button className="h-12 text-base sm:h-11 sm:text-sm" onClick={upload} disabled={progress !== null}>
              {progress !== null ? <Loader2 className="animate-spin" /> : <Upload />}
              {progress !== null ? 'Uploading…' : `Save ${picked.length} photo${picked.length === 1 ? '' : 's'}`}
            </Button>
            <Button variant="ghost" className="h-12 sm:h-11" onClick={closeUpload} disabled={progress !== null}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <PhotoViewer
        jobCardId={jobCardId}
        photos={shown}
        index={viewer}
        onIndexChange={setViewer}
        onClose={() => setViewer(null)}
        canEdit={canEdit}
      />
    </div>
  );
}
