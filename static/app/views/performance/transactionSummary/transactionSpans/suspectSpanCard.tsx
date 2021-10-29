import {ReactNode} from 'react';
import {useTheme} from '@emotion/react';
import styled from '@emotion/styled';
import {Location, LocationDescriptor, Query} from 'history';

import GridEditable, {COL_WIDTH_UNDEFINED} from 'app/components/gridEditable';
import SortLink from 'app/components/gridEditable/sortLink';
import Link from 'app/components/links/link';
import {RowRectangle} from 'app/components/performance/waterfall/rowBar';
import {pickBarColor, toPercent} from 'app/components/performance/waterfall/utils';
import Tooltip from 'app/components/tooltip';
import {t, tct} from 'app/locale';
import {Organization} from 'app/types';
import {defined} from 'app/utils';
import {TableDataRow} from 'app/utils/discover/discoverQuery';
import EventView from 'app/utils/discover/eventView';
import {getFieldRenderer} from 'app/utils/discover/fieldRenderers';
import {ColumnType, fieldAlignment} from 'app/utils/discover/fields';
import {formatPercentage} from 'app/utils/formatters';
import {SuspectSpan} from 'app/utils/performance/suspectSpans/types';

import {PerformanceDuration} from '../../utils';

import {
  emptyValue,
  HeaderItem,
  LowerPanel,
  SpanLabelContainer,
  UpperPanel,
} from './styles';
import {
  SpanSortOption,
  SpanSortOthers,
  SpanSortPercentiles,
  SuspectSpanDataRow,
  SuspectSpanTableColumn,
  SuspectSpanTableColumnKeys,
} from './types';
import {getSuspectSpanSortFromEventView} from './utils';

const SPANS_TABLE_COLUMN_ORDER: SuspectSpanTableColumn[] = [
  {
    key: 'id',
    name: 'Event ID',
    width: COL_WIDTH_UNDEFINED,
  },
  {
    key: 'timestamp',
    name: 'Timestamp',
    width: COL_WIDTH_UNDEFINED,
  },
  {
    key: 'spanDuration',
    name: 'Span Duration',
    width: COL_WIDTH_UNDEFINED,
  },
  {
    key: 'repeated',
    name: 'Repeated',
    width: COL_WIDTH_UNDEFINED,
  },
  {
    key: 'cumulativeDuration',
    name: 'Cumulative Duration',
    width: COL_WIDTH_UNDEFINED,
  },
];

const SPANS_TABLE_COLUMN_TYPE: Partial<Record<SuspectSpanTableColumnKeys, ColumnType>> = {
  id: 'string',
  timestamp: 'date',
  spanDuration: 'duration',
  repeated: 'integer',
  cumulativeDuration: 'duration',
};

type Props = {
  location: Location;
  organization: Organization;
  suspectSpan: SuspectSpan;
  generateTransactionLink: (
    organization: Organization,
    tableData: TableDataRow,
    query: Query,
    hash?: string
  ) => LocationDescriptor;
  eventView: EventView;
  totalCount: number | undefined;
};

export default function SuspectSpanEntry(props: Props) {
  const {
    location,
    organization,
    suspectSpan,
    generateTransactionLink,
    eventView,
    totalCount,
  } = props;

  const examples = suspectSpan.examples.map(example => ({
    id: example.id,
    project: suspectSpan.project,
    // finish timestamp is in seconds but want milliseconds
    timestamp: example.finishTimestamp * 1000,
    transactionDuration: (example.finishTimestamp - example.startTimestamp) * 1000,
    spanDuration: example.nonOverlappingExclusiveTime,
    repeated: example.spans.length,
    cumulativeDuration: example.spans.reduce(
      (duration, span) => duration + span.exclusiveTime,
      0
    ),
    spans: example.spans,
  }));

  const sort = getSuspectSpanSortFromEventView(eventView);

  return (
    <div data-test-id="suspect-card">
      <UpperPanel>
        <HeaderItem
          label={t('Span Operation')}
          value={<SpanLabel span={suspectSpan} />}
          align="left"
        />
        <PercentileDuration sort={sort} suspectSpan={suspectSpan} />
        <SpanCount sort={sort} suspectSpan={suspectSpan} totalCount={totalCount} />
        <HeaderItem
          label={t('Total Cumulative Duration')}
          value={
            <PerformanceDuration
              abbreviation
              milliseconds={suspectSpan.sumExclusiveTime}
            />
          }
          align="right"
          isSortKey={sort.field === SpanSortOthers.SUM_EXCLUSIVE_TIME}
        />
      </UpperPanel>
      <LowerPanel data-test-id="suspect-card-lower">
        <GridEditable
          data={examples}
          columnOrder={SPANS_TABLE_COLUMN_ORDER}
          columnSortBy={[]}
          grid={{
            renderHeadCell,
            renderBodyCell: renderBodyCellWithMeta(
              location,
              organization,
              generateTransactionLink,
              suspectSpan
            ),
          }}
          location={location}
        />
      </LowerPanel>
    </div>
  );
}

type HeaderItemProps = {
  sort: SpanSortOption;
  suspectSpan: SuspectSpan;
};

const PERCENTILE_LABELS: Record<SpanSortPercentiles, string> = {
  [SpanSortPercentiles.P50_EXCLUSIVE_TIME]: t('p50 Duration'),
  [SpanSortPercentiles.P75_EXCLUSIVE_TIME]: t('p75 Duration'),
  [SpanSortPercentiles.P95_EXCLUSIVE_TIME]: t('p95 Duration'),
  [SpanSortPercentiles.P99_EXCLUSIVE_TIME]: t('p99 Duration'),
};

function PercentileDuration(props: HeaderItemProps) {
  const {sort, suspectSpan} = props;

  const sortKey = PERCENTILE_LABELS.hasOwnProperty(sort.field)
    ? sort.field
    : SpanSortPercentiles.P75_EXCLUSIVE_TIME;

  return (
    <HeaderItem
      label={PERCENTILE_LABELS[sortKey]}
      value={<PerformanceDuration abbreviation milliseconds={suspectSpan[sortKey]} />}
      align="right"
      isSortKey={sort.field === sortKey}
    />
  );
}

function SpanCount(props: HeaderItemProps & {totalCount?: number}) {
  const {sort, suspectSpan, totalCount} = props;

  if (sort.field === SpanSortOthers.COUNT) {
    return (
      <HeaderItem
        label={t('Occurrences')}
        value={String(suspectSpan.count)}
        align="right"
        isSortKey
      />
    );
  }

  const value = defined(totalCount) ? (
    <Tooltip
      title={tct('[frequency] out of [total] transactions contain this span', {
        frequency: suspectSpan.frequency,
        total: totalCount,
      })}
    >
      <span>{formatPercentage(suspectSpan.frequency / totalCount)}</span>
    </Tooltip>
  ) : (
    String(suspectSpan.count)
  );

  return <HeaderItem label={t('Frequency')} value={value} align="right" />;
}

function renderHeadCell(column: SuspectSpanTableColumn, _index: number): ReactNode {
  const align = fieldAlignment(column.key, SPANS_TABLE_COLUMN_TYPE[column.key]);
  return (
    <SortLink
      title={column.name}
      align={align}
      direction={undefined}
      canSort={false}
      generateSortLink={() => undefined}
    />
  );
}

function renderBodyCellWithMeta(
  location: Location,
  organization: Organization,
  generateTransactionLink: (
    organization: Organization,
    tableData: TableDataRow,
    query: Query,
    hash?: string
  ) => LocationDescriptor,
  suspectSpan: SuspectSpan
) {
  return (column: SuspectSpanTableColumn, dataRow: SuspectSpanDataRow): ReactNode => {
    if (column.key === 'spanDuration' && dataRow.transactionDuration) {
      return (
        <SuspectSpanNonOverlappingDuration
          span={suspectSpan}
          transactionDuration={dataRow.transactionDuration}
          spanDuration={dataRow.spanDuration}
        />
      );
    }

    const fieldRenderer = getFieldRenderer(column.key, SPANS_TABLE_COLUMN_TYPE);
    let rendered = fieldRenderer(dataRow, {location, organization});

    if (column.key === 'id') {
      const worstSpan = dataRow.spans.length
        ? dataRow.spans.reduce((worst, span) =>
            worst.exclusiveTime >= span.exclusiveTime ? worst : span
          )
        : null;
      const hash = worstSpan ? `#span-${worstSpan.id}` : undefined;
      const target = generateTransactionLink(organization, dataRow, location.query, hash);

      rendered = <Link to={target}>{rendered}</Link>;
    }

    return rendered;
  };
}

const DurationBar = styled('div')`
  position: relative;
  display: flex;
`;

const DurationBarSection = styled(RowRectangle)`
  position: relative;
  width: 100%;
`;

type SuspectSpanNonOverlappingDurationProps = {
  span: SuspectSpan;
  transactionDuration: number;
  spanDuration: number;
};

function SuspectSpanNonOverlappingDuration(
  props: SuspectSpanNonOverlappingDurationProps
) {
  const {span, transactionDuration, spanDuration} = props;

  if (transactionDuration === 0) {
    // TODO: fallback
    return null;
  }

  const theme = useTheme();

  const widthPercentage = spanDuration / transactionDuration;

  return (
    <DurationBar>
      <div style={{width: toPercent(widthPercentage)}}>
        <Tooltip
          title={tct('[spanDuration] of [transactionDuration]', {
            spanDuration: (
              <PerformanceDuration abbreviation milliseconds={spanDuration} />
            ),
            transactionDuration: (
              <PerformanceDuration abbreviation milliseconds={transactionDuration} />
            ),
          })}
          containerDisplayMode="block"
        >
          <DurationBarSection
            spanBarHatch={false}
            style={{backgroundColor: pickBarColor(span.op)}}
          />
        </Tooltip>
      </div>
      <div style={{width: toPercent(1 - widthPercentage)}}>
        <DurationBarSection
          spanBarHatch={false}
          style={{backgroundColor: theme.gray100}}
        />
      </div>
    </DurationBar>
  );
}

type SpanLabelProps = {
  span: SuspectSpan;
};

function SpanLabel(props: SpanLabelProps) {
  const {span} = props;

  const example = span.examples.find(ex => defined(ex.description));

  return (
    <Tooltip title={`${span.op} - ${example?.description ?? t('n/a')}`}>
      <SpanLabelContainer>
        <span>{span.op}</span> - {example?.description ?? emptyValue}
      </SpanLabelContainer>
    </Tooltip>
  );
}
