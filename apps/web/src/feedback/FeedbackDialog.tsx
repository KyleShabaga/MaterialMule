import { FEEDBACK_TEXT_MAX, submitFeedbackResponseSchema } from '@materialmule/shared';
import {
  Building2,
  Bug,
  Check,
  CircleAlert,
  Lightbulb,
  MessageCircleQuestionMark,
  Send,
} from 'lucide-react';
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { apiFetch } from '../api/client';
import { pageName } from '../layout/page-title';
import {
  FEEDBACK_CHOICES,
  FEEDBACK_KIND_OF,
  FeedbackDialogContext,
  type FeedbackChoice,
  type FeedbackDialogController,
  type OpenFeedbackOptions,
} from './feedback-context';
import { feedbackPagePath } from './page-path';

const ICONS: Record<FeedbackChoice, typeof Bug> = {
  problem: Bug,
  idea: Lightbulb,
  question: MessageCircleQuestionMark,
};

const PLACEHOLDERS: Record<FeedbackChoice, string> = {
  problem: 'What were you doing, and what went wrong?',
  idea: 'What would make your work easier?',
  question: 'What would you like to know?',
};

export const SENT_TITLE = 'Sent.';
export const SENT_TEXT = 'An administrator will read it here in the office.';

interface Opening {
  /** Bumped per opening, so each one starts from a fresh form. */
  key: number;
  choice: FeedbackChoice;
  page: string | null;
  returnFocus: HTMLElement | null;
}

/**
 * Feedback & bugs (STRATA-104, round 10): a dialog over the current page, opened from the account
 * menu or the crash page. Mounted once by the shell; messages stay on the host (POST /api/feedback,
 * kept as an audit event that administrators read on Help).
 */
export function FeedbackDialogProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState<Opening>({
    key: 0,
    choice: 'problem',
    page: null,
    returnFocus: null,
  });
  const pathRef = useRef(pathname);
  useLayoutEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);

  const openDialog = useCallback((options?: OpenFeedbackOptions) => {
    const active = document.activeElement;
    setOpening((previous) => ({
      key: previous.key + 1,
      choice: options?.choice ?? 'problem',
      page: feedbackPagePath(pathRef.current),
      returnFocus:
        options?.returnFocus ??
        (active instanceof HTMLElement && active !== document.body ? active : null),
    }));
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  const value = useMemo<FeedbackDialogController>(
    () => ({ isOpen: open, open: openDialog, close }),
    [open, openDialog, close],
  );

  return (
    <FeedbackDialogContext.Provider value={value}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="gap-5 sm:max-w-[480px]"
          onCloseAutoFocus={(event) => {
            const target = opening.returnFocus;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <FeedbackForm
            key={opening.key}
            initialChoice={opening.choice}
            page={opening.page}
            onDone={close}
          />
        </DialogContent>
      </Dialog>
    </FeedbackDialogContext.Provider>
  );
}

type SendState = 'idle' | 'sending' | 'sent' | 'failed';

function FeedbackForm({
  initialChoice,
  page,
  onDone,
}: {
  initialChoice: FeedbackChoice;
  page: string | null;
  onDone: () => void;
}) {
  const [choice, setChoice] = useState<FeedbackChoice | ''>(initialChoice);
  const [text, setText] = useState('');
  const [includePage, setIncludePage] = useState(true);
  const [errors, setErrors] = useState<{ kind?: string; text?: string }>({});
  const [state, setState] = useState<SendState>('idle');
  const sending = useRef(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const kindRef = useRef<HTMLDivElement>(null);
  const ids = { kind: useId(), text: useId(), hint: useId(), page: useId() };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    const message = text.trim();
    const nextErrors: typeof errors = {};
    if (!choice) nextErrors.kind = 'Choose what kind.';
    if (!message) nextErrors.text = 'Write a few words about what happened first.';
    else if (message.length > FEEDBACK_TEXT_MAX)
      nextErrors.text = `Use at most ${FEEDBACK_TEXT_MAX} characters.`;
    setErrors(nextErrors);
    if (nextErrors.kind || nextErrors.text) {
      if (nextErrors.kind) kindRef.current?.querySelector<HTMLElement>('button')?.focus();
      else textRef.current?.focus();
      return;
    }

    sending.current = true;
    setState('sending');
    try {
      const response = await apiFetch('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({
          kind: FEEDBACK_KIND_OF[choice as FeedbackChoice],
          text: message,
          ...(page && includePage ? { page } : {}),
        }),
      });
      // Success only once the server has acknowledged it with the new record's ID.
      const body: unknown = response.ok ? await response.json().catch(() => null) : null;
      if (!response.ok || !submitFeedbackResponseSchema.safeParse(body).success) {
        setState('failed');
        return;
      }
      setState('sent');
    } catch {
      setState('failed');
    } finally {
      sending.current = false;
    }
  }

  if (state === 'sent') {
    return (
      <>
        <div role="status" className="flex flex-col items-start gap-4 pr-8">
          <span className="flex size-10 items-center justify-center rounded-full bg-stage-storage-bg text-stage-storage-fg">
            <Check className="size-5" aria-hidden="true" />
          </span>
          <DialogHeader className="text-left">
            <DialogTitle>{SENT_TITLE}</DialogTitle>
            <DialogDescription>{SENT_TEXT}</DialogDescription>
          </DialogHeader>
        </div>
        <DialogFooter>
          <Button autoFocus onClick={onDone}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }

  const busy = state === 'sending';
  const current = choice || initialChoice;
  return (
    <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)} noValidate>
      <DialogHeader className="pr-8 text-left">
        <DialogTitle>Feedback &amp; bugs</DialogTitle>
        <DialogDescription>
          Tell the administrator about a problem, an idea or a question.
        </DialogDescription>
      </DialogHeader>

      {state === 'failed' ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>It couldn’t be sent.</AlertTitle>
          <AlertDescription>Your text is kept here. Try again in a moment.</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-2">
        <span id={ids.kind} className="text-sm font-semibold">
          What kind
        </span>
        <ToggleGroup
          ref={kindRef}
          type="single"
          variant="outline"
          value={choice}
          onValueChange={(value) => {
            setChoice(value as FeedbackChoice | '');
            if (value) setErrors((e) => ({ ...e, kind: undefined }));
          }}
          aria-labelledby={ids.kind}
          aria-describedby={errors.kind ? `${ids.kind}-error` : undefined}
          className="w-full"
          disabled={busy}
        >
          {FEEDBACK_CHOICES.map(({ value, label }) => {
            const Icon = ICONS[value];
            return (
              <ToggleGroupItem key={value} value={value} className="flex-1">
                <Icon aria-hidden="true" />
                {label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        {errors.kind ? (
          <p id={`${ids.kind}-error`} className="text-sm text-destructive-text">
            {errors.kind}
          </p>
        ) : null}
      </div>

      <Field data-invalid={errors.text ? true : undefined}>
        <FieldLabel htmlFor={ids.text}>What happened</FieldLabel>
        <Textarea
          ref={textRef}
          id={ids.text}
          rows={4}
          className="min-h-28"
          placeholder={PLACEHOLDERS[current]}
          maxLength={FEEDBACK_TEXT_MAX}
          value={text}
          aria-invalid={errors.text ? true : undefined}
          aria-describedby={ids.hint}
          readOnly={busy}
          onChange={(event) => {
            setText(event.target.value);
            if (errors.text) setErrors((e) => ({ ...e, text: undefined }));
            if (state === 'failed') setState('idle');
          }}
        />
        {errors.text ? (
          <p id={ids.hint} className="flex items-center gap-2 text-sm text-destructive-text">
            <CircleAlert className="size-4" aria-hidden="true" />
            {errors.text}
          </p>
        ) : (
          <FieldDescription id={ids.hint}>Never include passwords.</FieldDescription>
        )}
      </Field>

      {page ? (
        <Field orientation="horizontal">
          <Checkbox
            id={ids.page}
            checked={includePage}
            onCheckedChange={(checked) => setIncludePage(checked === true)}
            disabled={busy}
          />
          <FieldContent className="min-w-0">
            <FieldLabel htmlFor={ids.page}>Include the page I was on</FieldLabel>
            <FieldDescription className="truncate">
              {pageName(page)} · <span className="font-mono">{page}</span>
            </FieldDescription>
          </FieldContent>
        </Field>
      ) : null}

      <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
        <Building2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>Stays inside the office. Nothing is sent outside the building.</span>
      </p>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? (
            <Spinner role="presentation" aria-hidden="true" aria-label={undefined} />
          ) : (
            <Send aria-hidden="true" />
          )}
          {busy ? 'Sending…' : 'Send to the administrator'}
        </Button>
      </DialogFooter>
    </form>
  );
}
