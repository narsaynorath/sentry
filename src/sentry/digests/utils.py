from __future__ import annotations

from collections import Counter, OrderedDict, defaultdict
from datetime import datetime
from typing import Any
from typing import Counter as CounterType
from typing import Iterable, Mapping

from sentry.digests import Digest
from sentry.eventstore.models import Event
from sentry.models import ProjectOwnership, Team, User
from sentry.notifications.types import ActionTargetType
from sentry.types.integrations import ExternalProviders


def get_digest_metadata(
    digest: Digest,
) -> tuple[datetime | None, datetime | None, CounterType[str]]:
    """TODO MARCOS describe"""
    start: datetime | None = None
    end: datetime | None = None

    counts: CounterType[str] = Counter()
    for rule, groups in digest.items():
        counts.update(groups.keys())

        for group, records in groups.items():
            for record in records:
                if record.datetime:
                    if start is None or record.datetime < start:
                        start = record.datetime

                    if end is None or record.datetime > end:
                        end = record.datetime

    return start, end, counts


def should_get_personalized_digests(target_type: ActionTargetType, project_id: int) -> bool:
    return (
        target_type == ActionTargetType.ISSUE_OWNERS
        and ProjectOwnership.objects.filter(project_id=project_id).exists()
    )


def get_digest_as_context(digest: Digest) -> Mapping[str, Any]:
    start, end, counts = get_digest_metadata(digest)
    group = next(iter(counts))

    return {
        "counts": counts,
        "digest": digest,
        "group": group,
        "end": end,
        "start": start,
    }


def get_events_by_participant(
    participants_by_provider_by_event: Mapping[Event, Mapping[ExternalProviders, set[Team | User]]]
) -> Mapping[Team | User, set[Event]]:
    """Invert a mapping of events to participants to a mapping of participants to events."""
    output = defaultdict(set)
    for event, participants_by_provider in participants_by_provider_by_event.items():
        for participants in participants_by_provider.values():
            for participant in participants:
                output[participant].add(event)
    return output


def get_personalized_digests(
    digest: Digest,
    participants_by_provider_by_event: Mapping[Event, Mapping[ExternalProviders, set[Team | User]]],
) -> Mapping[int, Digest]:
    events_by_participant = get_events_by_participant(participants_by_provider_by_event)
    return {
        participant.actor_id: build_custom_digest(digest, events)
        for participant, events in events_by_participant.items()
    }


def get_event_from_groups_in_digest(digest: Digest) -> Iterable[Event]:
    # TODO MARCOS 1 make sure this preserves ORDER!
    """Gets the first event from each group in the digest."""
    return {
        group_records[0].value.event
        for rule_groups in digest.values()
        for group_records in rule_groups.values()
    }


def build_custom_digest(original_digest: Digest, events: Iterable[Event]) -> Digest:
    """Given a digest and a set of events, filter the digest to only records that include the events."""
    user_digest: Digest = OrderedDict()
    for rule, rule_groups in original_digest.items():
        user_rule_groups = OrderedDict()
        for group, group_records in rule_groups.items():
            user_group_records = [
                record for record in group_records if record.value.event in events
            ]
            if user_group_records:
                user_rule_groups[group] = user_group_records
        if user_rule_groups:
            user_digest[rule] = user_rule_groups
    return user_digest
