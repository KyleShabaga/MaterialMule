import { Bug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOptionalFeedbackDialog } from '../feedback/feedback-context';
import { FeedbackReceived } from '../help/FeedbackReceived';
import { HelpGuidesView } from '../help/HelpGuidesView';
import { useMe } from '../session/context';
import './help.css';

/**
 * Help and how-tos inside the shell (`/help`, STRATA-103). The guides are the same as signed out
 * (help/public-help.tsx); signed in adds Ask a question and Feedback & bugs (the dialog replaced
 * Field Ledger's form), and administrators keep the feedback received under the guides.
 */
export function HelpPage() {
  const me = useMe();
  const feedback = useOptionalFeedbackDialog();
  // STRATA-118: Lab Managers manage staff but never read administrator Feedback.
  const isAdmin = me.permissions.includes('feedback.read');

  return (
    <div className="help-page">
      <HelpGuidesView
        onAsk={feedback ? () => feedback.open({ choice: 'question' }) : undefined}
        footExtra={
          feedback ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-[13px]"
              onClick={() => feedback.open()}
            >
              <Bug aria-hidden="true" />
              Feedback &amp; bugs
            </Button>
          ) : null
        }
      >
        {isAdmin ? <FeedbackReceived /> : null}
      </HelpGuidesView>
    </div>
  );
}
