import {Fragment, useState} from 'react';
import styled from '@emotion/styled';
import isNil from 'lodash/isNil';

import Pill from 'app/components/pill';
import Pills from 'app/components/pills';
import {t} from 'app/locale';
import {PlatformType, Project} from 'app/types';
import {Event} from 'app/types/event';
import {Thread} from 'app/types/events';
import {STACK_TYPE, STACK_VIEW} from 'app/types/stacktrace';
import {defined} from 'app/utils';

import TraceEventDataSection from '../traceEventDataSection';
import {DisplayOption} from '../traceEventDataSection/displayOptions';

import Exception from './crashContent/exception';
import StackTrace from './crashContent/stackTrace';
import ThreadSelector from './threads/threadSelector';
import findBestThread from './threads/threadSelector/findBestThread';
import getThreadException from './threads/threadSelector/getThreadException';
import getThreadStacktrace from './threads/threadSelector/getThreadStacktrace';
import NoStackTraceMessage from './noStackTraceMessage';
import {isStacktraceNewestFirst} from './utils';

type ExceptionProps = React.ComponentProps<typeof Exception>;

type Props = Pick<ExceptionProps, 'groupingCurrentLevel' | 'hasHierarchicalGrouping'> & {
  event: Event;
  projectId: Project['id'];
  type: string;
  data: {
    values?: Array<Thread>;
  };
};

type State = {
  activeThread?: Thread;
};

function getIntendedStackView(thread: Thread, event: Event) {
  const exception = getThreadException(event, thread);
  if (exception) {
    return !!exception.values.find(value => !!value.stacktrace?.hasSystemFrames)
      ? STACK_VIEW.APP
      : STACK_VIEW.FULL;
  }

  const stacktrace = getThreadStacktrace(false, thread);

  return stacktrace?.hasSystemFrames ? STACK_VIEW.APP : STACK_VIEW.FULL;
}

function Threads({
  data,
  event,
  projectId,
  type,
  hasHierarchicalGrouping,
  groupingCurrentLevel,
}: Props) {
  const [state, setState] = useState<State>(() => {
    const thread = defined(data.values) ? findBestThread(data.values) : undefined;
    return {activeThread: thread};
  });

  const threads = data.values ?? [];
  const stackTraceNotFound = !threads.length;
  const {activeThread} = state;

  const platform = (event.platform ?? 'other') as PlatformType;
  const hasMoreThanOneThread = threads.length > 1;
  const exception = getThreadException(event, activeThread);
  const stackView = activeThread ? getIntendedStackView(activeThread, event) : undefined;

  function renderPills() {
    const {id, name, current, crashed} = activeThread ?? {};

    if (isNil(id) || !name) {
      return null;
    }

    return (
      <Pills>
        {!isNil(id) && <Pill name={t('id')} value={String(id)} />}
        {!!name?.trim() && <Pill name={t('name')} value={name} />}
        {current !== undefined && <Pill name={t('was active')} value={current} />}
        {crashed !== undefined && (
          <Pill name={t('errored')} className={crashed ? 'false' : 'true'}>
            {crashed ? t('yes') : t('no')}
          </Pill>
        )}
      </Pills>
    );
  }

  function renderContent({
    recentFirst,
    raw,
    activeDisplayOptions,
  }: Parameters<React.ComponentProps<typeof TraceEventDataSection>['children']>[0]) {
    const stackType = activeDisplayOptions.includes(DisplayOption.MINIFIED)
      ? STACK_TYPE.MINIFIED
      : STACK_TYPE.ORIGINAL;

    if (exception) {
      return (
        <Exception
          stackType={stackType}
          stackView={
            raw
              ? STACK_VIEW.RAW
              : activeDisplayOptions.includes(DisplayOption.FULL_STACK_TRACE)
              ? STACK_VIEW.FULL
              : STACK_VIEW.APP
          }
          projectId={projectId}
          newestFirst={recentFirst}
          event={event}
          platform={platform}
          values={exception.values}
          groupingCurrentLevel={groupingCurrentLevel}
          hasHierarchicalGrouping={hasHierarchicalGrouping}
        />
      );
    }

    const stackTrace = getThreadStacktrace(
      stackType !== STACK_TYPE.ORIGINAL,
      activeThread
    );

    if (stackTrace) {
      return (
        <StackTrace
          stacktrace={stackTrace}
          stackView={
            raw
              ? STACK_VIEW.RAW
              : activeDisplayOptions.includes(DisplayOption.FULL_STACK_TRACE)
              ? STACK_VIEW.FULL
              : STACK_VIEW.APP
          }
          newestFirst={recentFirst}
          event={event}
          platform={platform}
          groupingCurrentLevel={groupingCurrentLevel}
          hasHierarchicalGrouping={hasHierarchicalGrouping}
          nativeV2
        />
      );
    }

    return (
      <NoStackTraceMessage
        message={activeThread?.crashed ? t('Thread Errored') : undefined}
      />
    );
  }

  function getTitle() {
    if (hasMoreThanOneThread && activeThread) {
      return (
        <ThreadSelector
          threads={threads}
          activeThread={activeThread}
          event={event}
          onChange={thread => {
            setState({
              ...state,
              activeThread: thread,
            });
          }}
          exception={exception}
          fullWidth
        />
      );
    }

    return <Title>{t('Stack Trace')}</Title>;
  }

  return (
    <TraceEventDataSection
      type={type}
      stackType={STACK_TYPE.ORIGINAL}
      projectId={projectId}
      eventId={event.id}
      recentFirst={isStacktraceNewestFirst()}
      fullStackTrace={stackView === STACK_VIEW.FULL}
      title={getTitle()}
      platform={platform}
      showPermalink={!hasMoreThanOneThread}
      hasMinified={
        !!exception?.values?.find(value => value.rawStacktrace) ||
        (hasMoreThanOneThread ? !!activeThread?.rawStacktrace : false)
      }
      hasVerboseFunctionNames={
        !!exception?.values?.find(
          value =>
            !!value.stacktrace?.frames?.find(
              frame =>
                defined(frame.rawFunction) &&
                defined(frame.function) &&
                frame.rawFunction !== frame.function
            )
        ) ||
        (hasMoreThanOneThread
          ? !!activeThread?.stacktrace?.frames?.find(
              frame =>
                defined(frame.rawFunction) &&
                defined(frame.function) &&
                frame.rawFunction !== frame.function
            )
          : false)
      }
      hasAbsoluteFilePaths={
        !!exception?.values?.find(
          value => !!value.stacktrace?.frames?.find(frame => defined(frame.filename))
        ) ||
        (hasMoreThanOneThread
          ? !!activeThread?.stacktrace?.frames?.find(frame => defined(frame.filename))
          : false)
      }
      hasAbsoluteAddresses={
        !!exception?.values?.find(
          value =>
            !!value.stacktrace?.frames?.find(frame => defined(frame.instructionAddr))
        ) ||
        (hasMoreThanOneThread
          ? !!activeThread?.stacktrace?.frames?.find(frame =>
              defined(frame.instructionAddr)
            )
          : false)
      }
      hasAppOnlyFrames={
        !!exception?.values?.find(
          value => !!value.stacktrace?.frames?.find(frame => !!frame.inApp)
        ) ||
        (hasMoreThanOneThread
          ? !!activeThread?.stacktrace?.frames?.find(frame => !!frame.inApp)
          : false)
      }
      hasNewestFirst={
        !!exception?.values?.find(value => (value.stacktrace?.frames ?? []).length > 1) ||
        (activeThread?.stacktrace?.frames ?? []).length > 1
      }
      stackTraceNotFound={stackTraceNotFound}
      wrapTitle={false}
    >
      {childrenProps => (
        <Fragment>
          {renderPills()}
          {renderContent(childrenProps)}
        </Fragment>
      )}
    </TraceEventDataSection>
  );
}

export default Threads;

const Title = styled('h3')`
  margin-bottom: 0;
`;
