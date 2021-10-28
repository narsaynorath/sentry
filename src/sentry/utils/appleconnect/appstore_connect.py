import io
import logging
import pathlib
import time
from collections import namedtuple
from http import HTTPStatus
from typing import Any, Dict, Generator, List, Mapping, NewType, Optional, Tuple

import sentry_sdk
from dateutil.parser import parse as parse_date
from requests import Session, Timeout

from sentry.utils import jwt, safe, sdk
from sentry.utils.json import JSONData

logger = logging.getLogger(__name__)

AppConnectCredentials = namedtuple("AppConnectCredentials", ["key_id", "key", "issuer_id"])

REQUEST_TIMEOUT = 15.0


class RequestError(Exception):
    """An error from the response."""

    pass


class UnauthorizedError(RequestError):
    """Unauthorised: invalid, expired or revoked authentication token."""

    pass


class ForbiddenError(RequestError):
    """The App Store Connect session does not have access to the requested dSYM."""

    pass


def _get_authorization_header(
    credentials: AppConnectCredentials, expiry_sec: Optional[int] = None
) -> Mapping[str, str]:
    """Creates a JWT (javascript web token) for use with app store connect API

    All requests to app store connect require an "Authorization" header build as below.

    Note: The maximum allowed expiry time is 20 minutes.  The default is somewhat shorter
    than that to avoid running into the limit.

    :return: the Bearer auth token to be added as the  "Authorization" header
    """
    if expiry_sec is None:
        expiry_sec = 60 * 10  # default to 10 mins
    with sentry_sdk.start_span(op="jwt", description="Generating AppStoreConnect JWT token"):
        token = jwt.encode(
            {
                "iss": credentials.issuer_id,
                "exp": int(time.time()) + expiry_sec,
                "aud": "appstoreconnect-v1",
            },
            credentials.key,
            algorithm="ES256",
            headers={"kid": credentials.key_id, "alg": "ES256", "typ": "JWT"},
        )
        return jwt.authorization_header(token)


def _get_appstore_json(
    session: Session, credentials: AppConnectCredentials, url: str
) -> Mapping[str, Any]:
    """Returns response data from an appstore URL.

    It builds and makes the request and extracts the data from the response.

    :returns: a dictionary with the requested data or None if the call fails.

    :raises ValueError: if the request failed or the response body could not be parsed as
       JSON.
    """
    with sentry_sdk.start_span(op="appconnect-request", description="AppStoreConnect API request"):
        headers = _get_authorization_header(credentials)

        if not url.startswith("https://"):
            full_url = "https://api.appstoreconnect.apple.com"
            if url[0] != "/":
                full_url += "/"
        else:
            full_url = ""
        full_url += url
        logger.debug(f"GET {full_url}")
        with sentry_sdk.start_span(op="http", description="AppStoreConnect request"):
            response = session.get(full_url, headers=headers, timeout=REQUEST_TIMEOUT)
        if not response.ok:
            err_info = {
                "url": full_url,
                "status_code": response.status_code,
            }
            try:
                err_info["json"] = response.json()
            except Exception:
                err_info["text"] = response.text

            with sentry_sdk.configure_scope() as scope:
                scope.set_extra("http.appconnect.api", err_info)

            if response.status_code == HTTPStatus.UNAUTHORIZED:
                raise UnauthorizedError(full_url)
            else:
                raise RequestError(full_url)
        try:
            return response.json()  # type: ignore
        except Exception as e:
            raise ValueError(
                "Response body not JSON", full_url, response.status_code, response.text
            ) from e


def _get_next_page(response_json: Mapping[str, Any]) -> Optional[str]:
    """Gets the URL for the next page from an App Store Connect paged response."""
    return safe.get_path(response_json, "links", "next")  # type: ignore


def _get_appstore_info_paged(
    session: Session, credentials: AppConnectCredentials, url: str
) -> Generator[Any, None, None]:
    """Iterates through all the pages from a paged response.

    App Store Connect responses shares the general format:

    data:
      - list of elements
    included:
      - list of included relations as requested
    links:
      next: link to the next page
    ...

    The function iterates through all pages (following the next link) until
    there is no next page, and returns a generator containing all pages

    :return: a generator with the pages.
    """
    next_url: Optional[str] = url
    while next_url is not None:
        response = _get_appstore_json(session, credentials, next_url)
        yield response
        next_url = _get_next_page(response)


_RelType = NewType("_RelType", str)
_RelId = NewType("_RelId", str)


class _IncludedRelations:
    """Related data which was returned with a page.

    The API allows to add an ``&include=some,types`` query parameter to the URLs which will
    automatically include related data of those types which are referred in the data of the
    page to be returned in the same request.  This class extracts this information from the
    page and makes it available to look up.

    :param data: The entire page data, the constructor will extract the included relations
       from this.
    """

    def __init__(self, page_data: JSONData):
        self._items: Dict[Tuple[_RelType, _RelId], JSONData] = {}
        for relation in page_data.get("included", []):
            rel_type = _RelType(relation["type"])
            rel_id = _RelId(relation["id"])
            self._items[(rel_type, rel_id)] = relation

    def get_related(self, data: JSONData, relation: str) -> Optional[JSONData]:
        """Returns the named relation of the object.

        ``data`` must be a JSON object which has a ``relationships`` object and
        ``relation`` is the key of the specific related data in this list required.  This
        function will read the object type and id from the relationships and look up the
        actual object in the page's related data.
        """
        rel_ptr_data = safe.get_path(data, "relationships", relation, "data")
        if rel_ptr_data is None:
            # Because the related information was requested in the query does not mean a
            # relation of that type did exist.
            # E.g. a query asks for both the appStoreVersion and preReleaseVersion relations
            # to be included.  However for each build there could be only one of these that
            # will have the data with type and id, the other will have None for data.
            return None
        assert isinstance(rel_ptr_data, dict)
        rel_type = _RelType(rel_ptr_data["type"])
        rel_id = _RelId(rel_ptr_data["id"])
        return self._items[(rel_type, rel_id)]

    def get_multiple_related(self, data: JSONData, relation: str) -> Optional[List[JSONData]]:
        """Returns a list of all the related objects of the named relation type.

        This is like :meth:`get_related` but is for relation types which have a list of
        related objects instead of exactly one.  An example of this is a ``build`` can have
        multiple ``buildBundles`` related to it.

        Having this as a separate method makes it easier to handle the type checking.
        """
        rel_ptr_data = safe.get_path(data, "relationships", relation, "data")
        if rel_ptr_data is None:
            # Because the related information was requested in the query does not mean a
            # relation of that type did exist.
            return None
        assert isinstance(rel_ptr_data, list)
        all_related = []
        for relationship in rel_ptr_data:
            rel_type = _RelType(relationship["type"])
            rel_id = _RelId(relationship["id"])
            related_item = self._items[(rel_type, rel_id)]
            if related_item:
                all_related.append(related_item)
        return all_related


def get_build_info(
    session: Session, credentials: AppConnectCredentials, app_id: str
) -> List[Dict[str, Any]]:
    """Returns the build infos for an application.

    The release build version information has the following structure:
    platform: str - the platform for the build (e.g. IOS, MAC_OS ...)
    version: str - the short version build info ( e.g. '1.0.1'), also called "train"
       in starship documentation
    build_number: str - the version of the build (e.g. '101'), looks like the build number
    uploaded_date: datetime - when the build was uploaded to App Store Connect
    """
    with sentry_sdk.start_span(
        op="appconnect-list-builds", description="List all AppStoreConnect builds"
    ):
        # https://developer.apple.com/documentation/appstoreconnectapi/list_builds
        url = (
            "v1/builds"
            # filter for this app only, our API key may give us access to more than one app
            f"?filter[app]={app_id}"
            # we can fetch a maximum of 200 builds at once, so do that
            "&limit=200"
            # include related AppStore/PreRelease versions with the response as well as
            # buildBundles which contains metadata on the debug resources (dSYMs)
            "&include=appStoreVersion,preReleaseVersion,buildBundles"
            # sort newer releases first
            "&sort=-uploadedDate"
            # only include valid builds
            "&filter[processingState]=VALID"
            # and builds that have not expired yet
            "&filter[expired]=false"
            # fetch the maximum number of build bundles
            "&limit[buildBundles]=50"
        )
        pages = _get_appstore_info_paged(session, credentials, url)
        build_info = []

        for page in pages:
            relations = _IncludedRelations(page)
            for build in page["data"]:
                try:
                    related_appstore_version = relations.get_related(build, "appStoreVersion")
                    related_prerelease_version = relations.get_related(build, "preReleaseVersion")

                    # Normally release versions also have a matching prerelease version, the
                    # platform and version number for them should be identical.  Nevertheless
                    # because we would likely see the build first with a prerelease version
                    # before it also has a release version we prefer to stick with that one if
                    # it is available.
                    if related_prerelease_version:
                        version = related_prerelease_version["attributes"]["version"]
                        platform = related_prerelease_version["attributes"]["platform"]
                    elif related_appstore_version:
                        version = related_appstore_version["attributes"]["versionString"]
                        platform = related_appstore_version["attributes"]["platform"]
                    else:
                        raise KeyError("missing related version")
                    build_number = build["attributes"]["version"]
                    uploaded_date = parse_date(build["attributes"]["uploadedDate"])

                    # https://developer.apple.com/documentation/appstoreconnectapi/build/relationships/buildbundles
                    build_bundles = relations.get_related(build, "buildBundles")
                    dsym_url = ""
                    # https://developer.apple.com/documentation/appstoreconnectapi/buildbundle/attributes
                    if build_bundles is not None:
                        has_symbols = [
                            bundle
                            for bundle in build_bundles
                            # TODO: fastlane uses this check, but if we turn this on our sentry test
                            # org has zero builds, making testing difficult. unsure what this field
                            # even means. maybe all of our dsyms on our test app don't actually have
                            # symbols?
                            # if safe.get_path(bundle, "attributes", "includesSymbols", default=False)
                            #
                            # if we want to rely on just checking for the presence of dSYMUrl then
                            # just transform build_bundles into a list of dSYMUrls instead.
                            # later we should prioritize bundles with includesSymbols == true and
                            # dSYMUrl being present
                            if safe.get_path(bundle, "attributes", "dSYMUrl") is not None
                        ]

                        # No bundles is self-explanatory, but multiple dSYMs for a build currently
                        # is unexpected.
                        if len(has_symbols) != 1:
                            with sentry_sdk.push_scope() as scope:
                                scope.set_context(
                                    "App Store Connect Build",
                                    {
                                        "build": build,
                                        "build_bundles": build_bundles,
                                    },
                                )
                                sentry_sdk.capture_message("len(buildBundlesWithdSYMs) != 1")

                        if len(has_symbols) > 0:
                            bundle = has_symbols[0]
                            dsym_url = safe.get_path(bundle, "attributes", "dSYMUrl")

                    # Literally a BuildInfo without the app id
                    result = {
                        "platform": platform,
                        "version": version,
                        "build_number": build_number,
                        "uploaded_date": uploaded_date,
                        "dsym_url": dsym_url,
                    }

                    build_info.append(result)
                except Exception:
                    logger.error(
                        "Failed to process AppStoreConnect build from API: %s",
                        build,
                        exc_info=True,
                    )

        return build_info


AppInfo = namedtuple("AppInfo", ["name", "bundle_id", "app_id"])


def get_apps(session: Session, credentials: AppConnectCredentials) -> Optional[List[AppInfo]]:
    """
    Returns the available applications from an account
    :return: a list of available applications or None if the login failed, an empty list
    means that the login was successful but there were no applications available
    """
    url = "v1/apps"
    ret_val = []
    try:
        app_pages = _get_appstore_info_paged(session, credentials, url)
        for app_page in app_pages:
            for app in safe.get_path(app_page, "data", default=[]):
                app_info = AppInfo(
                    app_id=app.get("id"),
                    bundle_id=safe.get_path(app, "attributes", "bundleId"),
                    name=safe.get_path(app, "attributes", "name"),
                )
                if (
                    app_info.app_id is not None
                    and app_info.bundle_id is not None
                    and app_info.name is not None
                ):
                    ret_val.append(app_info)
                else:
                    logger.error("Malformed AppStoreConnect `apps` data")
    except ValueError:
        return None
    return ret_val


def download_dsym(
    session: Session, credentials: AppConnectCredentials, url: str, path: pathlib.Path
) -> None:
    """
    Downloads a dSYM at `url` into `path`.
    """

    headers = _get_authorization_header(credentials)

    with session.get(url, headers=headers, stream=True, timeout=15) as res:
        status = res.status_code
        if status == HTTPStatus.UNAUTHORIZED:
            raise UnauthorizedError
        elif status == HTTPStatus.FORBIDDEN:
            raise ForbiddenError
        elif status != HTTPStatus.OK:
            raise RequestError(f"Bad status code downloading dSYM: {status}")

        start = time.time()
        bytes_count = 0
        with open(path, "wb") as fp:
            for chunk in res.iter_content(chunk_size=io.DEFAULT_BUFFER_SIZE):
                # The 315s is just above how long it would take a 4MB/s connection to download
                # 2GB.
                if (time.time() - start) > 315:
                    with sdk.configure_scope() as scope:
                        scope.set_extra("dSYM.bytes_fetched", bytes_count)
                    raise Timeout("Timeout during dSYM download")
                bytes_count += len(chunk)
                fp.write(chunk)
