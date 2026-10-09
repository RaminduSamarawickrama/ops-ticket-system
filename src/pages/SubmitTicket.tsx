import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  ALLOWED_IMAGE_TYPES,
  FIELD_LIMITS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_UPLOAD_BYTES,
  PRIORITIES,
  PRIORITY_INFO,
  type Priority,
} from '../../shared/constants';
import { fieldErrors, ticketInputSchema } from '../../shared/validation';
import { ApiError, apiForm } from '../api';
import { Alert, Header } from '../components/Layout';
import { formatBytes } from '../format';
import { prepareImage } from '../imageCompress';

interface FormState {
  subject: string;
  priority: Priority | '';
  reporterEmail: string;
  description: string;
  incidentDate: string;
  incidentTime: string;
  affectedSystem: string;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const EMPTY: FormState = {
  subject: '',
  priority: '',
  reporterEmail: '',
  description: '',
  incidentDate: '',
  incidentTime: '',
  affectedSystem: '',
};

interface Attachment {
  id: string;
  file: File;
  previewUrl: string;
}

export default function SubmitTicket() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preparingFiles, setPreparingFiles] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  // One id per attempt: if the same attempt reaches the server twice, only one ticket is created.
  const submissionId = useRef<string>(crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);

  // Release image previews when leaving the page.
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => filesRef.current.forEach((f) => URL.revokeObjectURL(f.previewUrl)), []);

  const totalBytes = useMemo(() => files.reduce((n, f) => n + f.file.size, 0), [files]);

  const set = (key: keyof FormState) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '' }));
    setFormError(null);
  };

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setErrors((e) => ({ ...e, screenshots: '' }));
    const incoming = Array.from(list);
    const room = MAX_FILES - files.length;
    if (incoming.length > room) {
      setErrors((e) => ({ ...e, screenshots: `You can attach up to ${MAX_FILES} screenshots.` }));
    }
    setPreparingFiles(true);
    const accepted: Attachment[] = [];
    for (const original of incoming.slice(0, Math.max(room, 0))) {
      if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(original.type)) {
        setErrors((e) => ({ ...e, screenshots: `"${original.name}" is not a PNG, JPG or WebP image.` }));
        continue;
      }
      const file = await prepareImage(original);
      if (!file) {
        setErrors((e) => ({ ...e, screenshots: `"${original.name}" is not a PNG, JPG or WebP image.` }));
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setErrors((e) => ({ ...e, screenshots: `"${original.name}" is too large (max ${formatBytes(MAX_FILE_BYTES)}).` }));
        continue;
      }
      accepted.push({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) });
    }
    setFiles((prev) => [...prev, ...accepted]);
    setPreparingFiles(false);
    if (fileInput.current) fileInput.current.value = '';
  }

  function removeFile(id: string) {
    setFiles((prev) => {
      const gone = prev.find((f) => f.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((f) => f.id !== id);
    });
    setErrors((e) => ({ ...e, screenshots: '' }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);

    const parsed = ticketInputSchema.safeParse(form);
    const errs = parsed.success ? {} : fieldErrors(parsed.error);
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
      errs.screenshots = `Screenshots total ${formatBytes(totalBytes)}; the limit is ${formatBytes(MAX_TOTAL_UPLOAD_BYTES)}. Remove some.`;
    }
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      setFormError('Please correct the highlighted fields.');
      document.querySelector<HTMLElement>(`[name="${Object.keys(errs)[0]}"]`)?.focus();
      return;
    }

    const body = new FormData();
    for (const [k, v] of Object.entries(form)) body.append(k, v);
    body.append('submissionId', submissionId.current);
    for (const f of files) body.append('screenshots', f.file, f.file.name);

    setSubmitting(true);
    try {
      const { data } = await apiForm<{ reference: string }>('/tickets', body);
      setReference(data.reference);
      window.scrollTo({ top: 0 });
    } catch (err) {
      // Keep everything the user typed so they can try again.
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setFormError(err.message);
      } else {
        setFormError('We could not reach the server. Check your connection and try again; your details are still here.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function startAnother() {
    files.forEach((f) => URL.revokeObjectURL(f.previewUrl));
    setFiles([]);
    setForm(EMPTY);
    setErrors({});
    setFormError(null);
    setReference(null);
    submissionId.current = crypto.randomUUID();
  }

  if (reference) {
    return (
      <>
        <Header />
        <main className="mx-auto max-w-2xl px-4 py-10">
          <div className="card p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl text-green-700" aria-hidden>
              ✓
            </div>
            <h1 className="text-xl font-semibold">Ticket submitted</h1>
            <p className="mt-2 text-slate-600">Your reference number is</p>
            <p className="mt-2 select-all font-mono text-3xl font-bold tracking-wide" data-testid="ticket-reference">
              {reference}
            </p>
            <p className="mx-auto mt-4 max-w-md text-sm text-slate-600">
              The operations team has been notified. A confirmation email is on its way to{' '}
              <strong>{form.reporterEmail.trim().toLowerCase()}</strong>, and you will get another email when the issue is resolved.
            </p>
            <button type="button" className="btn-secondary mt-6" onClick={startAnother}>
              Raise another ticket
            </button>
          </div>
        </main>
      </>
    );
  }

  const fieldClass = (k: string) => `input ${errors[k] ? 'input-error' : ''}`;
  const err = (k: string) =>
    errors[k] ? (
      <p id={`${k}-error`} className="field-error">
        {errors[k]}
      </p>
    ) : null;
  const describedBy = (k: string) => (errors[k] ? `${k}-error` : undefined);

  return (
    <>
      <Header
        right={
          <Link to="/admin" className="text-sm text-slate-600 hover:text-ink">
            Admin sign in
          </Link>
        }
      />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-semibold">Raise an operations ticket</h1>
        <p className="mt-1 text-slate-600">Tell us what went wrong. No account is needed. Fields marked * are required.</p>

        <form noValidate onSubmit={onSubmit} className="card mt-6 space-y-6 p-6" aria-busy={submitting}>
          {formError && <Alert kind="error">{formError}</Alert>}

          <div>
            <label htmlFor="subject" className="label">
              Ticket subject *
            </label>
            <input
              id="subject"
              name="subject"
              className={fieldClass('subject')}
              maxLength={FIELD_LIMITS.subject}
              placeholder="e.g. Payment system down"
              value={form.subject}
              onChange={(e) => set('subject')(e.target.value)}
              aria-invalid={!!errors.subject}
              aria-describedby={describedBy('subject')}
              required
            />
            {err('subject')}
          </div>

          <fieldset>
            <legend className="label">Priority *</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {PRIORITIES.map((p) => {
                const info = PRIORITY_INFO[p];
                const selected = form.priority === p;
                return (
                  <label
                    key={p}
                    className={`relative flex cursor-pointer flex-col rounded-lg border-2 bg-white p-3 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-600 ${
                      selected ? 'shadow-md' : 'border-slate-200 hover:border-slate-300'
                    }`}
                    style={selected ? { borderColor: info.color } : undefined}
                  >
                    <input
                      type="radio"
                      name="priority"
                      value={p}
                      checked={selected}
                      onChange={() => set('priority')(p)}
                      className="sr-only"
                    />
                    <span className="flex items-center gap-2 font-semibold">
                      <span className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10" style={{ backgroundColor: info.color }} aria-hidden />
                      {info.label}
                    </span>
                    <span className="mt-1 text-xs leading-snug text-slate-600">{info.description}</span>
                    {selected && (
                      <span className="absolute right-2 top-2 text-sm font-bold" style={{ color: p === 'P2' ? '#A16207' : info.color }} aria-hidden>
                        ✓
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            {err('priority')}
          </fieldset>

          <div>
            <label htmlFor="reporterEmail" className="label">
              Your email address *
            </label>
            <input
              id="reporterEmail"
              name="reporterEmail"
              type="email"
              autoComplete="email"
              className={fieldClass('reporterEmail')}
              maxLength={FIELD_LIMITS.email}
              placeholder="name@company.com"
              value={form.reporterEmail}
              onChange={(e) => set('reporterEmail')(e.target.value)}
              aria-invalid={!!errors.reporterEmail}
              aria-describedby={describedBy('reporterEmail')}
              required
            />
            {err('reporterEmail')}
          </div>

          <div>
            <label htmlFor="affectedSystem" className="label">
              Affected system *
            </label>
            <input
              id="affectedSystem"
              name="affectedSystem"
              className={fieldClass('affectedSystem')}
              maxLength={FIELD_LIMITS.affectedSystem}
              placeholder="Application, platform or service, e.g. Booking engine"
              value={form.affectedSystem}
              onChange={(e) => set('affectedSystem')(e.target.value)}
              aria-invalid={!!errors.affectedSystem}
              aria-describedby={describedBy('affectedSystem')}
              required
            />
            {err('affectedSystem')}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="incidentDate" className="label">
                Incident date *
              </label>
              <input
                id="incidentDate"
                name="incidentDate"
                type="date"
                max={today()}
                className={fieldClass('incidentDate')}
                value={form.incidentDate}
                onChange={(e) => set('incidentDate')(e.target.value)}
                aria-invalid={!!errors.incidentDate}
                aria-describedby={describedBy('incidentDate')}
                required
              />
              {err('incidentDate')}
            </div>
            <div>
              <label htmlFor="incidentTime" className="label">
                Incident time *
              </label>
              <input
                id="incidentTime"
                name="incidentTime"
                type="time"
                className={fieldClass('incidentTime')}
                value={form.incidentTime}
                onChange={(e) => set('incidentTime')(e.target.value)}
                aria-invalid={!!errors.incidentTime}
                aria-describedby={describedBy('incidentTime')}
                required
              />
              {err('incidentTime')}
            </div>
          </div>

          <div>
            <label htmlFor="description" className="label">
              Incident description *
            </label>
            <textarea
              id="description"
              name="description"
              rows={6}
              className={fieldClass('description')}
              maxLength={FIELD_LIMITS.description}
              placeholder="What happened, what you were doing when it happened, any error messages, and who is affected."
              value={form.description}
              onChange={(e) => set('description')(e.target.value)}
              aria-invalid={!!errors.description}
              aria-describedby={describedBy('description') ?? 'description-hint'}
              required
            />
            <p id="description-hint" className="mt-1 text-xs text-slate-500">
              {form.description.length}/{FIELD_LIMITS.description} characters
            </p>
            {err('description')}
          </div>

          <div>
            <span className="label">Screenshots (optional)</span>
            <p className="mb-2 text-xs text-slate-500">
              Up to {MAX_FILES} images: PNG, JPG or WebP. Large images are resized automatically.
            </p>
            <input
              ref={fileInput}
              id="screenshots"
              name="screenshots"
              type="file"
              accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
              multiple
              className="sr-only"
              onChange={(e) => addFiles(e.target.files)}
              disabled={files.length >= MAX_FILES || preparingFiles}
            />
            <label
              htmlFor="screenshots"
              className={`btn-secondary cursor-pointer ${files.length >= MAX_FILES || preparingFiles ? 'pointer-events-none opacity-60' : ''}`}
            >
              {preparingFiles ? 'Preparing images…' : 'Add screenshots'}
            </label>
            {files.length > 0 && (
              <ul className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200">
                {files.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 p-2">
                    <img src={f.previewUrl} alt="" className="h-12 w-16 rounded border border-slate-200 object-cover" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{f.file.name}</p>
                      <p className="text-xs text-slate-500">{formatBytes(f.file.size)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(f.id)}
                      className="rounded px-2 py-1 text-sm text-red-700 hover:bg-red-50"
                      aria-label={`Remove ${f.file.name}`}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {err('screenshots')}
          </div>

          <div className="flex flex-col-reverse items-stretch gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-end">
            <button type="submit" className="btn-primary min-w-40" disabled={submitting || preparingFiles}>
              {submitting ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
                  Submitting…
                </>
              ) : (
                'Submit ticket'
              )}
            </button>
          </div>
        </form>
      </main>
    </>
  );
}
