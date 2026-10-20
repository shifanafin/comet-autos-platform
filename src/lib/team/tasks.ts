import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { TaskStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission, AuthError } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { getStorage, sniffAudio, sniffImage } from '@/lib/storage';
import { storageKey } from '@/lib/storage/keys';
import { CLOSED_JOB_STATUSES } from '@/lib/workshop/stages';
import { nextStatuses, taskAbilities, type TaskActor } from '@/lib/team/task-rules';
import { TASK_STATUS_LABEL } from '@/lib/team/labels';
import { notify } from '@/lib/notifications/service';

/*
 * Tasks: the team's to-do lists.
 *
 * Someone with task.create gives a task to one or several employees —
 * typed, or spoken and confirmed — and it lands on each one's "My work"
 * list. Anyone with a login and an employee record also keeps their own
 * to-dos. Who may change what is decided in one place, lib/team/task-rules.
 *
 * Photos and voice notes are stored like job photos: bytes to the storage
 * driver under a generated key, a Document row (PHOTO or VOICE_NOTE) tied
 * to the task, served only through a permission-checked route. A voice note
 * is kept only when the speaker chose to keep it; the text they confirmed is
 * what the task says either way.
 */

export const MAX_TASK_PHOTOS = 6;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;
export const MAX_ASSIGNEES = 30;

const languageSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, 'Choose a language.')
  .optional()
  .or(z.literal(''));

const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.')
  .optional()
  .or(z.literal(''));

const createSchema = z.object({
  title: z
    .string({ error: 'Say or type what needs doing.' })
    .trim()
    .min(2, 'Say or type what needs doing.')
    .max(200, 'Keep the first line under 200 characters — put the rest in the details.'),
  details: z.string().trim().max(4000, 'Keep the details under 4,000 characters.').optional(),
  language: languageSchema,
  assigneeIds: z.array(z.string().uuid()).max(MAX_ASSIGNEES).optional(),
  dueDate: dueDateSchema,
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  jobCardId: z.string().uuid().optional().or(z.literal('')),
  requestKey: z.string().optional(),
});

const updateSchema = z.object({
  body: z.string().trim().max(4000, 'Keep the note under 4,000 characters.').optional(),
  language: languageSchema,
  requestKey: z.string().optional(),
});

const statusSchema = z.object({
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']),
  comment: z.string().trim().max(1000).optional(),
  requestKey: z.string().optional(),
});

const moveSchema = z.object({
  dueDate: z
    .string({ error: 'Choose the new day.' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the new day.'),
  reason: z
    .string({ error: 'Say why it is being moved.' })
    .trim()
    .min(3, 'Say why it is being moved.')
    .max(500, 'Keep the reason under 500 characters.'),
  language: languageSchema,
  requestKey: z.string().optional(),
});

const editSchema = z.object({
  title: createSchema.shape.title,
  details: createSchema.shape.details,
  dueDate: dueDateSchema,
  priority: createSchema.shape.priority,
  jobCardId: createSchema.shape.jobCardId,
  assigneeId: z.string().uuid().optional().or(z.literal('')),
  requestKey: z.string().optional(),
});

export interface IncomingFile {
  name: string;
  bytes: Buffer;
}

// ─── Who is asking ──────────────────────────────────────────────────────────

const branchScope = (user: AuthenticatedUser) =>
  user.primaryBranchId ? { branchId: user.primaryBranchId } : {};

async function actorFor(user: AuthenticatedUser): Promise<TaskActor> {
  const employee = await prisma.employee.findFirst({
    where: { organizationId: user.organizationId, userId: user.id },
    select: { id: true },
  });
  return {
    userId: user.id,
    employeeId: employee?.id ?? null,
    canViewAll: hasPermission(user, 'task.view'),
    canEditAll: hasPermission(user, 'task.edit'),
    canCancelAll: hasPermission(user, 'task.delete'),
  };
}

/** The signed-in person's employee record (with its branch), or null. */
async function myEmployee(user: AuthenticatedUser) {
  return prisma.employee.findFirst({
    where: { organizationId: user.organizationId, userId: user.id, isActive: true },
    select: { id: true, branchId: true, firstName: true, lastName: true },
  });
}

const todayDate = () => parseCalendarDate(localDateString())!;

function resolveDueDate(value: string | undefined, { allowPast }: { allowPast: boolean }) {
  if (!value) return null;
  const date = parseCalendarDate(value);
  if (!date) throw new DomainError('Choose a valid date.', 'dueDate');
  if (!allowPast && value < localDateString()) {
    throw new DomainError('The due date can’t be in the past.', 'dueDate');
  }
  return date;
}

async function resolveJobCard(tx: Prisma.TransactionClient, user: AuthenticatedUser, id: string | undefined) {
  if (!id) return null;
  const job = await tx.jobCard.findFirst({
    where: { id, organizationId: user.organizationId },
    select: { id: true },
  });
  if (!job) throw new DomainError('That job card could not be found.', 'jobCardId');
  return job.id;
}

// ─── Files ──────────────────────────────────────────────────────────────────

interface CheckedFile {
  name: string;
  bytes: Buffer;
  kind: 'PHOTO' | 'VOICE_NOTE';
  mimeType: string;
  key: string;
}

/** Checks every file by its bytes and size before anything is stored. */
function checkFiles(photos: IncomingFile[], voice: IncomingFile | null): CheckedFile[] {
  if (photos.length > MAX_TASK_PHOTOS) {
    throw new DomainError(`Add up to ${MAX_TASK_PHOTOS} photos at a time.`, 'photos');
  }
  const checked: CheckedFile[] = photos.map((file) => {
    if (file.bytes.length === 0) throw new DomainError(`“${file.name}” is empty.`, 'photos');
    if (file.bytes.length > MAX_PHOTO_BYTES) {
      throw new DomainError(`“${file.name}” is larger than 10 MB.`, 'photos');
    }
    const type = sniffImage(file.bytes);
    if (!type) throw new DomainError(`“${file.name}” isn’t a JPEG, PNG or WebP photo.`, 'photos');
    return { ...file, kind: 'PHOTO', mimeType: type.mimeType, key: storageKey('team', type.extension) };
  });
  if (voice) {
    if (voice.bytes.length === 0) throw new DomainError('The voice recording is empty.', 'voice');
    if (voice.bytes.length > MAX_VOICE_BYTES) {
      throw new DomainError('The voice recording is longer than the system keeps (10 MB). Record a shorter one.', 'voice');
    }
    const type = sniffAudio(voice.bytes);
    if (!type) throw new DomainError('The voice recording isn’t in a format the system can keep.', 'voice');
    checked.push({ ...voice, kind: 'VOICE_NOTE', mimeType: type.mimeType, key: storageKey('team', type.extension) });
  }
  return checked;
}

async function storeFiles(files: CheckedFile[]) {
  const storage = getStorage();
  for (const file of files) await storage.put(file.key, file.bytes, file.mimeType);
}

async function recordFiles(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  task: { id: string; branchId: string },
  files: CheckedFile[],
  owner: { entityType: 'Task' | 'TaskUpdate'; entityId: string },
) {
  for (const file of files) {
    await tx.document.create({
      data: {
        organizationId: user.organizationId,
        branchId: task.branchId,
        entityType: owner.entityType,
        entityId: owner.entityId,
        taskId: task.id,
        documentType: file.kind,
        fileName:
          file.name.replace(/[^\w .()-]/g, '_').slice(0, 120) ||
          (file.kind === 'PHOTO' ? 'photo' : 'voice-note'),
        storageKey: file.key,
        mimeType: file.mimeType,
        fileSize: file.bytes.length,
        uploadedByUserId: user.id,
      },
    });
  }
}

// ─── Creating ───────────────────────────────────────────────────────────────

/**
 * Creates one task per person. With no assignees it is the signed-in
 * person's own to-do; naming anyone else (or several people) needs
 * task.create. Files are stored once and attached to every copy.
 */
export async function createTasks(
  user: AuthenticatedUser,
  rawInput: unknown,
  files: { photos: IncomingFile[]; voice: IncomingFile | null } = { photos: [], voice: null },
) {
  const input = parseInput(createSchema, rawInput);
  const me = await myEmployee(user);
  const assigneeIds = [...new Set(input.assigneeIds ?? [])];
  const forOthers = assigneeIds.some((id) => id !== me?.id);

  if (assigneeIds.length === 0 && !me) {
    throw new DomainError(
      'Your login isn’t linked to an employee record, so you have no to-do list of your own. Choose who the task is for.',
      'assigneeIds',
    );
  }
  if (forOthers) requirePermission(user, 'task.create');
  // Every task sits on a day of someone's list: no date means today.
  const dueDate = resolveDueDate(input.dueDate || localDateString(), { allowPast: false });
  const checked = checkFiles(files.photos, files.voice);

  const employees = assigneeIds.length
    ? await prisma.employee.findMany({
        where: { id: { in: assigneeIds }, organizationId: user.organizationId, ...branchScope(user) },
        select: { id: true, branchId: true, isActive: true, firstName: true, userId: true },
      })
    : [{ id: me!.id, branchId: me!.branchId, isActive: true, firstName: me!.firstName, userId: user.id }];
  if (employees.length !== (assigneeIds.length || 1)) throw new NotFoundError('employee');
  const inactive = employees.find((employee) => !employee.isActive);
  if (inactive) throw new DomainError(`${inactive.firstName} is no longer active.`, 'assigneeIds');

  await storeFiles(checked);

  const created = await prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'task.create');
    const jobCardId = await resolveJobCard(tx, user, input.jobCardId || undefined);
    const created: { id: string; assigneeEmployeeId: string }[] = [];
    for (const employee of employees) {
      const task = await tx.task.create({
        data: {
          organizationId: user.organizationId,
          branchId: employee.branchId,
          assigneeEmployeeId: employee.id,
          title: input.title.replace(/\s+/g, ' '),
          details: emptyToNull(input.details),
          language: emptyToNull(input.language),
          isAssigned: employee.id !== me?.id,
          priority: input.priority,
          dueDate,
          originalDueDate: dueDate,
          jobCardId,
          createdByUserId: user.id,
        },
        select: { id: true, branchId: true, assigneeEmployeeId: true },
      });
      await recordFiles(tx, user, task, checked, { entityType: 'Task', entityId: task.id });
      await writeAuditLog(tx, {
        organizationId: user.organizationId,
        branchId: task.branchId,
        actorUserId: user.id,
        action: employee.id === me?.id ? 'task.todo_added' : 'task.assigned',
        entityType: 'Task',
        entityId: task.id,
        afterData: {
          title: input.title,
          assigneeEmployeeId: employee.id,
          dueDate: input.dueDate || null,
          priority: input.priority,
          jobCardId,
          photos: checked.filter((file) => file.kind === 'PHOTO').length,
          voiceNote: checked.some((file) => file.kind === 'VOICE_NOTE'),
          language: emptyToNull(input.language),
        },
      });
      created.push(task);
    }
    await settleRequestKey(tx, user, rawInput, created[0].id);
    return created;
  });

  // Tell each person a task was given to them (not someone adding their own).
  const sender = user.fullName.split(' ')[0] || 'Your manager';
  await Promise.all(
    created.map((task) => {
      const employee = employees.find((entry) => entry.id === task.assigneeEmployeeId);
      if (!employee?.userId || employee.userId === user.id) return null;
      return notify({
        organizationId: user.organizationId,
        userId: employee.userId,
        kind: 'TASK_ASSIGNED',
        title: `New task from ${sender}`,
        body: input.title.replace(/\s+/g, ' '),
        href: `/team/tasks/${task.id}`,
      }).catch((error) => console.error('Task notification failed', error));
    }),
  );
  return created;
}

// ─── Loading one task ───────────────────────────────────────────────────────

async function loadTaskFor(user: AuthenticatedUser, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, organizationId: user.organizationId },
    select: {
      id: true,
      branchId: true,
      assigneeEmployeeId: true,
      createdByUserId: true,
      isAssigned: true,
      status: true,
      title: true,
      details: true,
      dueDate: true,
      priority: true,
      jobCardId: true,
    },
  });
  if (!task) throw new NotFoundError('task');
  const actor = await actorFor(user);
  const can = taskAbilities(actor, task);
  // A branch-bound viewer only sees their branch's team — unless it is theirs.
  const outOfBranch =
    user.primaryBranchId && task.branchId !== user.primaryBranchId && actor.employeeId !== task.assigneeEmployeeId;
  if (!can.see || outOfBranch) throw new NotFoundError('task');
  return { task, actor, can };
}

/** One task with its history, photos and voice notes, and what this user may do with it. */
export async function getTask(user: AuthenticatedUser, taskId: string) {
  const { task, actor, can } = await loadTaskFor(user, taskId);
  const full = await prisma.task.findUniqueOrThrow({
    where: { id: task.id },
    select: {
      id: true,
      title: true,
      details: true,
      language: true,
      isAssigned: true,
      priority: true,
      status: true,
      dueDate: true,
      originalDueDate: true,
      timesMoved: true,
      highlighted: true,
      startedAt: true,
      completedAt: true,
      cancelledAt: true,
      createdAt: true,
      assigneeEmployeeId: true,
      assignee: { select: { id: true, firstName: true, lastName: true, jobTitle: true } },
      createdBy: { select: { fullName: true } },
      completedBy: { select: { fullName: true } },
      jobCard: {
        select: { id: true, jobNumber: true, status: true, vehicle: { select: { plateNumber: true, make: true, model: true } } },
      },
      updates: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          kind: true,
          body: true,
          language: true,
          fromStatus: true,
          toStatus: true,
          changes: true,
          createdAt: true,
          author: { select: { fullName: true } },
        },
      },
      documents: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, documentType: true, entityType: true, entityId: true, mimeType: true, createdAt: true },
      },
    },
  });
  const dueKey = full.dueDate?.toISOString().slice(0, 10) ?? null;
  return {
    ...full,
    dueKey,
    overdue: isOpen(full.status) && dueKey !== null && dueKey < localDateString(),
    mine: actor.employeeId === full.assigneeEmployeeId,
    can,
    next: nextStatuses(full.status).filter((status) => can.progress && (status !== 'CANCELLED' || can.cancel)),
  };
}

export type TaskDetail = Awaited<ReturnType<typeof getTask>>;

const isOpen = (status: TaskStatus) => status === 'TODO' || status === 'IN_PROGRESS';

// ─── Working a task ─────────────────────────────────────────────────────────

/** A note, photos or a voice note on a task. Anyone who can see it may add one. */
export async function addTaskUpdate(
  user: AuthenticatedUser,
  taskId: string,
  rawInput: unknown,
  files: { photos: IncomingFile[]; voice: IncomingFile | null } = { photos: [], voice: null },
) {
  const input = parseInput(updateSchema, rawInput);
  const { task, can } = await loadTaskFor(user, taskId);
  if (!can.comment) throw new DomainError('This task was cancelled. Reopen it to add to it.');
  const checked = checkFiles(files.photos, files.voice);
  if (!input.body && checked.length === 0) {
    throw new DomainError('Say or type a note, or add a photo.', 'body');
  }
  await storeFiles(checked);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'task.note');
    const update = await tx.taskUpdate.create({
      data: {
        organizationId: user.organizationId,
        taskId: task.id,
        authorUserId: user.id,
        kind: 'NOTE',
        body: emptyToNull(input.body),
        language: emptyToNull(input.language),
      },
      select: { id: true },
    });
    await recordFiles(tx, user, task, checked, { entityType: 'TaskUpdate', entityId: update.id });
    await tx.task.update({ where: { id: task.id }, data: { updatedAt: new Date() } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: task.branchId,
      actorUserId: user.id,
      action: 'task.note_added',
      entityType: 'Task',
      entityId: task.id,
      afterData: { updateId: update.id, photos: checked.filter((f) => f.kind === 'PHOTO').length, voiceNote: checked.some((f) => f.kind === 'VOICE_NOTE') },
    });
    await settleRequestKey(tx, user, rawInput, update.id);
    return update;
  });
}

/** Moves a task along: start it, finish it, reopen it, or cancel it. */
export async function setTaskStatus(user: AuthenticatedUser, taskId: string, rawInput: unknown) {
  const input = parseInput(statusSchema, rawInput);
  const { task, can } = await loadTaskFor(user, taskId);
  if (input.status === task.status) return { id: task.id };
  if (input.status === 'CANCELLED') {
    if (!can.cancel) {
      throw task.isAssigned
        ? new DomainError('This task was given to you — only a manager can cancel it. Add a note to say why it can’t be done.')
        : new AuthError('task.delete');
    }
  } else {
    if (!can.progress) throw new AuthError('task.edit');
    if (!nextStatuses(task.status).includes(input.status)) {
      throw new DomainError(`A task that is “${TASK_STATUS_LABEL[task.status]}” can’t move to “${TASK_STATUS_LABEL[input.status]}”.`);
    }
  }

  const now = new Date();
  const data: Prisma.TaskUncheckedUpdateInput = { status: input.status };
  if (input.status === 'IN_PROGRESS') data.startedAt = now;
  if (input.status === 'DONE') {
    data.completedAt = now;
    data.completedByUserId = user.id;
  }
  if (input.status === 'CANCELLED') data.cancelledAt = now;
  if (input.status === 'TODO') {
    data.completedAt = null;
    data.completedByUserId = null;
    data.cancelledAt = null;
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'task.status');
    // Re-read inside the transaction: two taps from two phones agree.
    const current = await tx.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } });
    if (current.status === input.status) return { id: task.id };
    await tx.task.update({ where: { id: task.id }, data });
    await tx.taskUpdate.create({
      data: {
        organizationId: user.organizationId,
        taskId: task.id,
        authorUserId: user.id,
        kind: 'STATUS',
        fromStatus: current.status,
        toStatus: input.status,
        body: emptyToNull(input.comment),
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: task.branchId,
      actorUserId: user.id,
      action: input.status === 'CANCELLED' ? 'task.cancelled' : 'task.status_changed',
      entityType: 'Task',
      entityId: task.id,
      beforeData: { status: current.status },
      afterData: { status: input.status, comment: emptyToNull(input.comment) },
    });
    await settleRequestKey(tx, user, rawInput, task.id);
    return { id: task.id };
  });
}

/**
 * Changes a task's wording, date, priority, job card or assignee. On a task
 * someone gave you, none of these are yours to change (task-rules).
 */
export async function editTask(user: AuthenticatedUser, taskId: string, rawInput: unknown) {
  const input = parseInput(editSchema, rawInput);
  const { task, can } = await loadTaskFor(user, taskId);
  if (!can.edit) {
    if (task.isAssigned && !hasPermission(user, 'task.edit')) {
      throw new DomainError('This task was given to you, so its wording and due date can only be changed by a manager. Add a note instead.');
    }
    throw new DomainError('Only open tasks can be changed.');
  }

  const dueKeyBefore = task.dueDate?.toISOString().slice(0, 10) ?? '';
  // The date is the manager's to set here; the assignee moves it, with a reason (moveTask).
  const dueDate =
    !can.dueDate || (input.dueDate ?? '') === dueKeyBefore
      ? task.dueDate
      : resolveDueDate(input.dueDate || localDateString(), { allowPast: false });
  const assigneeId = input.assigneeId || task.assigneeEmployeeId;
  if (assigneeId !== task.assigneeEmployeeId && !can.reassign) throw new AuthError('task.edit');

  const result = await prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'task.edit');
    let branchId = task.branchId;
    if (assigneeId !== task.assigneeEmployeeId) {
      const employee = await tx.employee.findFirst({
        where: { id: assigneeId, organizationId: user.organizationId, isActive: true, ...branchScope(user) },
        select: { id: true, branchId: true },
      });
      if (!employee) throw new DomainError('Choose someone on the team.', 'assigneeId');
      branchId = employee.branchId;
    }
    const jobCardId = await resolveJobCard(tx, user, input.jobCardId || undefined);
    const after = {
      title: input.title.replace(/\s+/g, ' '),
      details: emptyToNull(input.details),
      dueDate: dueDate?.toISOString().slice(0, 10) ?? null,
      priority: input.priority,
      jobCardId,
      assigneeEmployeeId: assigneeId,
    };
    const before = {
      title: task.title,
      details: task.details,
      dueDate: dueKeyBefore || null,
      priority: task.priority,
      jobCardId: task.jobCardId,
      assigneeEmployeeId: task.assigneeEmployeeId,
    };
    const changes = Object.fromEntries(
      (Object.keys(after) as (keyof typeof after)[])
        .filter((field) => after[field] !== before[field])
        .map((field) => [field, [before[field], after[field]]]),
    );
    if (Object.keys(changes).length === 0) return { id: task.id };

    await tx.task.update({
      where: { id: task.id },
      data: {
        title: after.title,
        details: after.details,
        dueDate,
        priority: after.priority,
        jobCardId,
        assigneeEmployeeId: assigneeId,
        branchId,
        // Moved to someone else by a manager: it is now given, not a to-do.
        ...(assigneeId !== task.assigneeEmployeeId ? { isAssigned: true } : {}),
      },
    });
    await tx.taskUpdate.create({
      data: {
        organizationId: user.organizationId,
        taskId: task.id,
        authorUserId: user.id,
        kind: 'CHANGED',
        changes: changes as Prisma.InputJsonValue,
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId,
      actorUserId: user.id,
      action: assigneeId !== task.assigneeEmployeeId ? 'task.reassigned' : 'task.edited',
      entityType: 'Task',
      entityId: task.id,
      beforeData: before,
      afterData: after,
    });
    await settleRequestKey(tx, user, rawInput, task.id);
    return { id: task.id };
  });

  // Moved to someone else: they hear about it like a new task.
  if (assigneeId !== task.assigneeEmployeeId) {
    const assignee = await prisma.employee.findUnique({ where: { id: assigneeId }, select: { userId: true } });
    if (assignee?.userId && assignee.userId !== user.id) {
      await notify({
        organizationId: user.organizationId,
        userId: assignee.userId,
        kind: 'TASK_ASSIGNED',
        title: `New task from ${user.fullName.split(' ')[0] || 'your manager'}`,
        body: input.title.replace(/\s+/g, ' '),
        href: `/team/tasks/${task.id}`,
      }).catch((error) => console.error('Task notification failed', error));
    }
  }
  return result;
}

/**
 * Moves a task to another day. The assignee may do this even on a task a
 * manager gave them — but always with a reason, and the move stays in the
 * task's history and on its card ("moved 2×, first due 3 Oct").
 */
export async function moveTask(user: AuthenticatedUser, taskId: string, rawInput: unknown) {
  const input = parseInput(moveSchema, rawInput);
  const { task, can } = await loadTaskFor(user, taskId);
  if (!can.move) {
    throw new DomainError('Only open tasks on your own list can be moved.');
  }
  const date = resolveDueDate(input.dueDate, { allowPast: false })!;
  const before = task.dueDate?.toISOString().slice(0, 10) ?? null;
  if (before === input.dueDate) throw new DomainError('It is already on that day.', 'dueDate');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'task.move');
    await tx.task.update({
      where: { id: task.id },
      data: {
        dueDate: date,
        timesMoved: { increment: 1 },
        // Tasks made before original dates were kept: remember the first one now.
        ...(before ? {} : { originalDueDate: date }),
      },
    });
    await tx.taskUpdate.create({
      data: {
        organizationId: user.organizationId,
        taskId: task.id,
        authorUserId: user.id,
        kind: 'MOVED',
        body: input.reason,
        language: emptyToNull(input.language),
        changes: { dueDate: [before, input.dueDate] },
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: task.branchId,
      actorUserId: user.id,
      action: 'task.moved',
      entityType: 'Task',
      entityId: task.id,
      beforeData: { dueDate: before },
      afterData: { dueDate: input.dueDate, reason: input.reason },
    });
    await settleRequestKey(tx, user, rawInput, task.id);
    return { id: task.id };
  });
}

/** Stars or unstars a task on the assignee's own list. */
export async function setTaskHighlight(user: AuthenticatedUser, taskId: string, highlighted: boolean) {
  const { task, can } = await loadTaskFor(user, taskId);
  if (!can.highlight) throw new DomainError('Only tasks on your own list can be starred.');
  await prisma.task.update({ where: { id: task.id }, data: { highlighted } });
  return { id: task.id };
}

// ─── Lists ──────────────────────────────────────────────────────────────────

const listSelect = {
  id: true,
  title: true,
  details: true,
  language: true,
  isAssigned: true,
  priority: true,
  status: true,
  dueDate: true,
  originalDueDate: true,
  timesMoved: true,
  highlighted: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  assignee: { select: { id: true, firstName: true, lastName: true } },
  createdBy: { select: { fullName: true } },
  jobCard: { select: { id: true, jobNumber: true, vehicle: { select: { plateNumber: true } } } },
  _count: { select: { documents: { where: { deletedAt: null } }, updates: { where: { kind: 'NOTE' as const } } } },
} satisfies Prisma.TaskSelect;

type ListRow = Prisma.TaskGetPayload<{ select: typeof listSelect }>;

const keyOf = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;

function present(row: ListRow, today: string) {
  const dueKey = keyOf(row.dueDate);
  const open = isOpen(row.status);
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    language: row.language,
    isAssigned: row.isAssigned,
    priority: row.priority,
    status: row.status,
    dueKey,
    originalDueKey: keyOf(row.originalDueDate),
    timesMoved: row.timesMoved,
    highlighted: row.highlighted,
    overdue: open && dueKey !== null && dueKey < today,
    dueToday: open && dueKey === today,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    assignee: { id: row.assignee.id, name: `${row.assignee.firstName} ${row.assignee.lastName}` },
    givenBy: row.createdBy.fullName,
    jobCard: row.jobCard ? { id: row.jobCard.id, jobNumber: row.jobCard.jobNumber, plate: row.jobCard.vehicle.plateNumber } : null,
    attachments: row._count.documents,
    notes: row._count.updates,
  };
}

export type TaskListItem = ReturnType<typeof present>;

const PRIORITY_ORDER = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 } as const;

/** Within a day: starred first, then open before done, then priority, then oldest. */
function withinDay(a: TaskListItem, b: TaskListItem) {
  return (
    Number(b.highlighted) - Number(a.highlighted) ||
    Number(!isOpen(a.status)) - Number(!isOpen(b.status)) ||
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
    a.createdAt.getTime() - b.createdAt.getTime()
  );
}

/** Open tasks first by urgency: overdue, today, by date, undated; then within the day. */
function byUrgency(a: TaskListItem, b: TaskListItem) {
  const rank = (task: TaskListItem) => (task.overdue ? 0 : task.dueToday ? 1 : task.dueKey ? 2 : 3);
  return rank(a) - rank(b) || (a.dueKey ?? '').localeCompare(b.dueKey ?? '') || withinDay(a, b);
}

export interface TaskDayGroup {
  /** "YYYY-MM-DD". */
  date: string;
  kind: 'overdue' | 'today' | 'upcoming' | 'day';
  tasks: TaskListItem[];
  /** For a past day viewed as history: tasks that were due then and were moved away. */
  movedAway?: TaskListItem[];
}

/** Groups tasks by their day, days in date order, each day sorted. */
function groupByDay(tasks: TaskListItem[], kind: (date: string) => TaskDayGroup['kind']): TaskDayGroup[] {
  const days = new Map<string, TaskListItem[]>();
  for (const task of tasks) {
    const date = task.dueKey ?? localDateString();
    days.set(date, [...(days.get(date) ?? []), task]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({ date, kind: kind(date), tasks: list.sort(withinDay) }));
}

const dayStart = (key: string) => new Date(`${key}T00:00:00+04:00`);

/**
 * The signed-in person's to-do list.
 *
 * With no date: every day still pending before today under its own heading
 * (oldest first), then today — done ones included, struck through, along
 * with anything from an earlier day ticked off today — then the days ahead.
 *
 * With a date: that day's page — what was due that day (done or not), what
 * was finished that day, and what had been planned for it but was moved.
 */
export async function listMyTasks(user: AuthenticatedUser, date?: string) {
  const me = await myEmployee(user);
  if (!me) return null;
  const today = localDateString();
  const mine = { organizationId: user.organizationId, assigneeEmployeeId: me.id };

  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) && parseCalendarDate(date) ? date : null;
  const counts = await prisma.task.groupBy({
    by: ['status'],
    where: { ...mine, status: { in: ['TODO', 'IN_PROGRESS'] } },
    _count: { _all: true },
  });
  const overdueCount = await prisma.task.count({
    where: { ...mine, status: { in: ['TODO', 'IN_PROGRESS'] }, dueDate: { lt: parseCalendarDate(today)! } },
  });
  const openCount = counts.reduce((sum, row) => sum + row._count._all, 0);

  if (day && day !== today) {
    const start = dayStart(day);
    const end = new Date(start.getTime() + 86_400_000);
    const rows = await prisma.task.findMany({
      where: {
        ...mine,
        status: { not: 'CANCELLED' },
        OR: [
          { dueDate: parseCalendarDate(day)! },
          { completedAt: { gte: start, lt: end } },
          { originalDueDate: parseCalendarDate(day)! },
        ],
      },
      select: listSelect,
      take: 300,
    });
    const tasks = rows.map((row) => present(row, today));
    const onDay = tasks.filter(
      (task) => task.dueKey === day || (task.completedAt && task.completedAt >= start && task.completedAt < end),
    );
    const movedAway = tasks.filter((task) => !onDay.includes(task));
    return {
      employeeId: me.id,
      view: 'day' as const,
      date: day,
      groups: [{ date: day, kind: 'day' as const, tasks: onDay.sort(withinDay), movedAway }],
      counts: { open: openCount, overdue: overdueCount },
    };
  }

  const todayStart = dayStart(today);
  const rows = await prisma.task.findMany({
    where: {
      ...mine,
      OR: [
        { status: { in: ['TODO', 'IN_PROGRESS'] } },
        { status: 'DONE', OR: [{ dueDate: parseCalendarDate(today)! }, { completedAt: { gte: todayStart } }] },
      ],
    },
    select: listSelect,
    take: 500,
  });
  const tasks = rows.map((row) => present(row, today));
  // A task ticked off today shows under today, whatever day it was due.
  const placed = tasks.map((task) =>
    task.status === 'DONE' ? { ...task, dueKey: today } : task,
  );
  const groups = groupByDay(placed, (key) => (key < today ? 'overdue' : key === today ? 'today' : 'upcoming'));
  if (!groups.some((group) => group.kind === 'today')) {
    const at = groups.findIndex((group) => group.date > today);
    groups.splice(at === -1 ? groups.length : at, 0, { date: today, kind: 'today', tasks: [] });
  }
  return {
    employeeId: me.id,
    view: 'list' as const,
    date: today,
    groups,
    counts: { open: openCount, overdue: overdueCount },
  };
}

export type MyTasks = NonNullable<Awaited<ReturnType<typeof listMyTasks>>>;

/** How many open tasks someone has — the badge on their menu. */
export async function countMyOpenTasks(user: AuthenticatedUser): Promise<number> {
  return prisma.task.count({
    where: {
      organizationId: user.organizationId,
      status: { in: ['TODO', 'IN_PROGRESS'] },
      assignee: { userId: user.id },
    },
  });
}

const teamFilterSchema = z.object({
  employee: z.string().uuid().optional().catch(undefined),
  show: z.enum(['open', 'overdue', 'done', 'all']).catch('open'),
});

/**
 * The team board: every active employee with today's attendance and their
 * task counts, and the tasks matching the filter.
 */
export async function getTeamBoard(user: AuthenticatedUser, rawFilters: unknown = {}) {
  requirePermission(user, 'task.view');
  const filters = teamFilterSchema.parse(rawFilters ?? {});
  const todayKey = localDateString();
  const today = todayDate();
  const scope = { organizationId: user.organizationId, ...branchScope(user) };

  const [employees, attendance, openCounts, overdueCounts, doneToday] = await Promise.all([
    prisma.employee.findMany({
      where: { ...scope, isActive: true },
      select: { id: true, firstName: true, lastName: true, jobTitle: true, employeeCode: true, userId: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 500,
    }),
    prisma.attendance.findMany({
      where: { ...scope, attendanceDate: today },
      select: { employeeId: true, clockInAt: true, clockOutAt: true, status: true },
    }),
    prisma.task.groupBy({
      by: ['assigneeEmployeeId'],
      where: { ...scope, status: { in: ['TODO', 'IN_PROGRESS'] } },
      _count: { _all: true },
    }),
    prisma.task.groupBy({
      by: ['assigneeEmployeeId'],
      where: { ...scope, status: { in: ['TODO', 'IN_PROGRESS'] }, dueDate: { lt: today } },
      _count: { _all: true },
    }),
    prisma.task.groupBy({
      by: ['assigneeEmployeeId'],
      where: { ...scope, status: 'DONE', completedAt: { gte: new Date(`${todayKey}T00:00:00+04:00`) } },
      _count: { _all: true },
    }),
  ]);

  const count = (rows: { assigneeEmployeeId: string; _count: { _all: number } }[]) =>
    new Map(rows.map((row) => [row.assigneeEmployeeId, row._count._all]));
  const open = count(openCounts);
  const overdue = count(overdueCounts);
  const done = count(doneToday);
  const days = new Map(attendance.map((row) => [row.employeeId, row]));

  const team = employees.map((employee) => {
    const day = days.get(employee.id);
    return {
      id: employee.id,
      name: `${employee.firstName} ${employee.lastName}`,
      jobTitle: employee.jobTitle,
      code: employee.employeeCode,
      hasLogin: employee.userId !== null,
      presence: !day?.clockInAt
        ? day?.status === 'ON_LEAVE' || day?.status === 'ABSENT' || day?.status === 'HOLIDAY'
          ? ('AWAY' as const)
          : ('NOT_IN' as const)
        : day.clockOutAt
          ? ('LEFT' as const)
          : ('IN' as const),
      clockInAt: day?.clockInAt ?? null,
      clockOutAt: day?.clockOutAt ?? null,
      open: open.get(employee.id) ?? 0,
      overdue: overdue.get(employee.id) ?? 0,
      doneToday: done.get(employee.id) ?? 0,
    };
  });

  const where: Prisma.TaskWhereInput = {
    ...scope,
    ...(filters.employee ? { assigneeEmployeeId: filters.employee } : {}),
    ...(filters.show === 'open' ? { status: { in: ['TODO', 'IN_PROGRESS'] } } : {}),
    ...(filters.show === 'overdue' ? { status: { in: ['TODO', 'IN_PROGRESS'] }, dueDate: { lt: today } } : {}),
    ...(filters.show === 'done' ? { status: 'DONE' } : {}),
  };
  const rows = await prisma.task.findMany({
    where,
    select: listSelect,
    orderBy: filters.show === 'done' ? { completedAt: 'desc' } : { createdAt: 'desc' },
    take: 200,
  });
  const tasks = rows.map((row) => present(row, todayKey));
  if (filters.show === 'open' || filters.show === 'overdue') tasks.sort(byUrgency);

  return {
    filters,
    team,
    tasks,
    totals: {
      in: team.filter((member) => member.presence === 'IN').length,
      team: team.length,
      open: team.reduce((sum, member) => sum + member.open, 0),
      overdue: team.reduce((sum, member) => sum + member.overdue, 0),
      doneToday: team.reduce((sum, member) => sum + member.doneToday, 0),
    },
  };
}

export type TeamBoard = Awaited<ReturnType<typeof getTeamBoard>>;

/** Who a task can be given to, for the assign form. */
export async function listAssignableEmployees(user: AuthenticatedUser) {
  requirePermission(user, 'task.create');
  const employees = await prisma.employee.findMany({
    where: { organizationId: user.organizationId, ...branchScope(user), isActive: true },
    select: { id: true, firstName: true, lastName: true, jobTitle: true, userId: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    take: 500,
  });
  return employees.map((employee) => ({
    id: employee.id,
    name: `${employee.firstName} ${employee.lastName}`,
    jobTitle: employee.jobTitle,
    hasLogin: employee.userId !== null,
  }));
}

/** Job cards still in the workshop, to link a task to. */
export async function listOpenJobCardsForTasks(user: AuthenticatedUser) {
  if (!hasPermission(user, 'job_card.view')) return [];
  const jobs = await prisma.jobCard.findMany({
    where: { organizationId: user.organizationId, ...branchScope(user), status: { notIn: CLOSED_JOB_STATUSES } },
    orderBy: { openedAt: 'desc' },
    take: 200,
    select: { id: true, jobNumber: true, vehicle: { select: { plateNumber: true, make: true, model: true } } },
  });
  return jobs.map((job) => ({
    id: job.id,
    label: `${job.jobNumber} · ${job.vehicle.plateNumber}${job.vehicle.make ? ` · ${job.vehicle.make} ${job.vehicle.model ?? ''}`.trimEnd() : ''}`,
  }));
}

/** Open tasks on a job card, for the job card and the live board. */
export async function countOpenTasksByJob(organizationId: string, jobCardIds: string[]) {
  if (jobCardIds.length === 0) return new Map<string, number>();
  const rows = await prisma.task.groupBy({
    by: ['jobCardId'],
    where: { organizationId, jobCardId: { in: jobCardIds }, status: { in: ['TODO', 'IN_PROGRESS'] } },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.jobCardId!, row._count._all]));
}

// ─── Media ──────────────────────────────────────────────────────────────────

/**
 * Confirms this user may see a task's photo or voice note. Anything else —
 * another organization's file, a removed one, a job photo — is not found.
 */
export async function authorizeTaskMedia(user: AuthenticatedUser, documentId: string) {
  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      organizationId: user.organizationId,
      documentType: { in: ['PHOTO', 'VOICE_NOTE'] },
      deletedAt: null,
      taskId: { not: null },
    },
    select: { storageKey: true, mimeType: true, fileName: true, taskId: true },
  });
  if (!document?.taskId) throw new NotFoundError('file');
  await loadTaskFor(user, document.taskId);
  return document;
}
