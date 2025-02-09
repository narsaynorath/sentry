import Feature from 'app/components/acl/feature';
import {useOrganization} from 'app/utils/useOrganization';

import RelayWrapper from './relayWrapper';

function OrganizationRelay(props: Omit<RelayWrapper['props'], 'organization'>) {
  const organization = useOrganization();
  return (
    <Feature
      organization={organization}
      features={['relay']}
      hookName="feature-disabled:relay"
    >
      <RelayWrapper
        organization={organization as RelayWrapper['props']['organization']}
        {...props}
      />
    </Feature>
  );
}

export default OrganizationRelay;
